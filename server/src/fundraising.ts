import type { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { amendDonation, foldLedger, recordDonation, voidDonation } from "./ledger";
import { requireRole } from "./authz";
type SyncSettings = { form_id: string; start_date: string; enabled: number; last_sync_at: number | null; last_error: string; imported_count: number };
type RemoteGift = { id: string; amount: number; donor: string; anonymous: boolean; method: "card" | "check" | "cash"; date: string };
type ObjectValue = Record<string, unknown>;
const ACTOR = "Bloomerang Fundraising";
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const list = (value: unknown): unknown[] => value == null ? [] : Array.isArray(value) ? value : [value];

function cents(value: unknown): number {
  const text = String(value);
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new Error("Fundraising returned an invalid monetary amount; no gifts were changed.");
  const [whole, fraction = ""] = text.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(result)) throw new Error("Fundraising amount exceeds supported precision.");
  return result;
}

export type ParsedFundraising = { gifts: RemoteGift[]; skipped: { id: string; reason: string }[] };

/**
 * Batch-level problems (wrong token, missing form, truncated list) throw and nothing is imported.
 * Row-level problems (a ticket purchase without a donation allocation, an unknown status, an
 * unparseable amount) skip that row with a reason and never hold up the other gifts.
 */
export function parseFundraisingGifts(payload: unknown, formId: string): ParsedFundraising {
  const forms = object(payload).forms;
  if (!Array.isArray(forms)) throw new Error("Fundraising returned an invalid response; check the form token.");
  const form = forms.map(object).find(row => String(row.id) === formId);
  if (!form) throw new Error("The configured gala form is not accessible with this token.");
  if (!Array.isArray(form.transactions)) throw new Error("Fundraising transaction list is missing.");
  if (Number(object(form.summary).totalTransactions) !== form.transactions.length) throw new Error("Fundraising returned an incomplete transaction list; no gifts were changed.");
  const gifts: RemoteGift[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const seen = new Set<string>();
  form.transactions.forEach((value, index) => {
    const transaction = object(value);
    const id = String(transaction.id ?? "");
    const skip = (reason: string) => { skipped.push({ id: id || `row ${index + 1}`, reason }); };
    try {
      if (!/^\d+$/.test(id) || String(transaction.formId) !== formId) return skip("does not belong to the configured form");
      if (seen.has(id)) return skip("listed twice in the same response; the first copy was used");
      seen.add(id);
      const status = String(transaction.transStatus).toLowerCase();
      if (!["accepted", "refunded", "partially refunded", "voided", "declined", "pending"].includes(status)) return skip(`unsupported payment status "${transaction.transStatus}"`);
      const donationItems = list(transaction.donations);
      const mixedPurchase = [transaction.event, transaction.registrations, transaction.storePurchases, transaction.auctionPurchases].some(v => v != null && (Array.isArray(v) ? v.length > 0 : Object.keys(object(v)).length > 0));
      if (mixedPurchase && !donationItems.length) return skip("ticket or store purchase without a donation allocation");
      // Count the gift, not donor-covered processing fees or ticket purchases.
      const grossGift = donationItems.length
        ? donationItems.reduce<number>((sum, item) => sum + cents(object(item).donationAmount), 0)
        : Math.max(0, cents(transaction.value) - cents(transaction.giftAssist ?? 0));
      const refunds = list(object(transaction.refunds).refund ?? transaction.refunds);
      const refunded = refunds.reduce<number>((sum, value) => sum + cents(object(value).value), 0);
      const amount = status === "accepted" || status === "partially refunded" ? Math.max(0, grossGift - refunded) : 0;
      const donor = [transaction.firstName, transaction.lastName].filter(v => typeof v === "string" && v.trim()).join(" ") || String(transaction.billingName || transaction.contactCompany || "").trim();
      if (amount && !donor) return skip("gift without donor attribution");
      const anonymousValue = transaction.transactionWasAnonymous;
      const anonymous = !["n", false, 0, "0"].includes(anonymousValue as string | boolean | number) || donationItems.some(item => object(object(item).privacyCommunicationSelection).showName === "n");
      const payment = String(transaction.paymentType).toLowerCase();
      const method = payment.includes("check") ? "check" : payment.includes("cash") ? "cash" : "card";
      gifts.push({ id, amount, donor, anonymous, method, date: String(transaction.transactionDate || "") });
    } catch (error) {
      skip(error instanceof Error && /monetary|precision/.test(error.message) ? "unreadable amount" : "unreadable transaction");
    }
  });
  return { gifts, skipped };
}

export function applyFundraisingGifts(db: Database, formId: string, gifts: RemoteGift[]): number {
  return db.transaction(() => {
    let changed = 0;
    const records = foldLedger(db).all_records;
    for (const gift of gifts) {
      const key = `fundraising:${formId}:${gift.id}`;
      const donationId = `qgiv-${formId}-${gift.id}`;
      const snapshot = JSON.stringify(gift);
      const receipt = db.query<{ remote_snapshot: string }, [string]>("SELECT remote_snapshot FROM fundraising_receipt WHERE transaction_id = ?").get(key);
      const existing = records.get(donationId);
      if (receipt?.remote_snapshot === snapshot && existing) continue;
      const input = { amount_cents: gift.amount, donor_name: gift.donor, is_anonymous: gift.anonymous, payment_method: gift.method, entered_by: ACTOR, confirmed_major_gift: true, notes: `Fundraising transaction ${gift.id}; source date ${gift.date}` };
      if (!existing && gift.amount > 0) {
        const result = recordDonation(db, { ...input, donation_id: donationId, source: "bloomerang", source_txn_id: key });
        if (!result.is_duplicate) changed++;
      } else if (existing && !existing.is_voided && receipt?.remote_snapshot !== snapshot) {
        if (gift.amount === 0) voidDonation(db, donationId, ACTOR, "Upstream payment void or refund");
        else amendDonation(db, donationId, input);
        changed++;
      }
      // An operator-voided donation stays voided; polling must never resurrect it.
      db.query("INSERT INTO fundraising_receipt (transaction_id, donation_id, remote_snapshot) VALUES (?, ?, ?) ON CONFLICT(transaction_id) DO UPDATE SET remote_snapshot = excluded.remote_snapshot").run(key, donationId, snapshot);
    }
    return changed;
  })();
}

export function createFundraisingSync(db: Database, readToken = () => {
  const path = process.env.GIVEBAR_FUNDRAISING_TOKEN_FILE;
  return path ? readFileSync(path, "utf8").trim() : "";
}) {
  // Online gifts reach the wall as soon as the reporting API shows them: poll every
  // 5 s. After a failure (HTTP error, timeout, rejected token) the timer waits
  // RETRY_AFTER_FAILURE_MS before trying again so an outage or a rate limit never turns
  // into a request storm; the optional manual check always runs immediately.
  const POLL_MS = 5000;
  const RETRY_AFTER_FAILURE_MS = 30000;
  let running = false;
  let retryAt = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const settings = () => db.query<SyncSettings, []>("SELECT * FROM fundraising_sync WHERE id = 1").get()!;
  const tokenAvailable = () => { try { return !!readToken(); } catch { return false; } };
  const status = () => ({ ...settings(), token_configured: tokenAvailable(), running, interval_seconds: POLL_MS / 1000, retry_in_seconds: Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)) });
  async function sync() {
    if (running) return status();
    const config = settings();
    if (!config.enabled) return status();
    running = true;
    try {
      const token = readToken();
      if (!token) throw new Error("The Fundraising token has not been provisioned on this server.");
      const date = (value: string) => value.slice(5, 7) + value.slice(8, 10) + value.slice(0, 4);
      const response = await fetch(`https://secure.qgiv.com/admin/api/reporting/transactions/dates/${date(config.start_date)}:${date(new Date().toISOString().slice(0, 10))}.json`, {
        method: "POST", body: new URLSearchParams({ token }), redirect: "error", signal: AbortSignal.timeout(20000)
      });
      if (!response.ok) throw new Error(`Fundraising request failed (HTTP ${response.status}).`);
      const { gifts, skipped } = parseFundraisingGifts(await response.json(), config.form_id);
      // Do not apply an in-flight response after an operator disables or changes the form.
      const latest = settings();
      if (!latest.enabled || latest.form_id !== config.form_id || latest.start_date !== config.start_date) return status();
      const attention = skipped.length
        ? `${skipped.length} transaction${skipped.length === 1 ? " needs" : "s need"} attention and ${skipped.length === 1 ? "was" : "were"} not imported: ${skipped.slice(0, 5).map(row => `#${row.id} (${row.reason})`).join(", ")}${skipped.length > 5 ? ", …" : ""}. Every other gift is in.`
        : "";
      db.transaction(() => {
        applyFundraisingGifts(db, config.form_id, gifts);
        db.query("UPDATE fundraising_sync SET last_sync_at = ?, last_error = ?, imported_count = ? WHERE id = 1").run(Date.now(), attention, gifts.filter(g => g.amount > 0).length);
      })();
      retryAt = 0;
    } catch (error) {
      const message = error instanceof Error && /^(Fundraising|The configured|The Fundraising|A mixed)/.test(error.message) ? error.message : "Fundraising connection failed; no unverified gifts were imported.";
      db.query("UPDATE fundraising_sync SET last_error = ? WHERE id = 1").run(message);
      retryAt = Date.now() + RETRY_AFTER_FAILURE_MS;
    } finally { running = false; }
    return status();
  }
  async function handle(req: Request): Promise<Response> {
    const auth = requireRole(db, req, ["admin", "operator"]);
    if (auth instanceof Response) return auth;
    if (req.method === "GET") return Response.json(status(), { headers: { "Cache-Control": "no-store" } });
    if (req.method !== "POST") return Response.json({ error: "METHOD_NOT_ALLOWED" }, { status: 405 });
    try {
      const body = object(await req.json());
      if (body.action === "sync") return Response.json(await sync());
      if (body.action !== "configure") return Response.json({ error: "INVALID_ACTION" }, { status: 400 });
      if (auth.role !== "admin") return Response.json({ error: "FORBIDDEN", message: "Administrator access required." }, { status: 403 });
      const formId = String(body.form_id || "");
      const start = String(body.start_date || "");
      if (!/^\d+$/.test(formId) || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !Number.isFinite(Date.parse(start)) || new Date(start).toISOString().slice(0, 10) !== start || start > new Date().toISOString().slice(0, 10)) return Response.json({ error: "Provide a valid form ID and past or current start date." }, { status: 400 });
      if (body.enabled && !tokenAvailable()) return Response.json({ error: "Provision the server token before enabling import." }, { status: 400 });
      db.query("UPDATE fundraising_sync SET form_id = ?, start_date = ?, enabled = ?, last_sync_at = NULL, last_error = '' WHERE id = 1").run(formId, start, body.enabled === true ? 1 : 0);
      return Response.json(await sync());
    } catch { return Response.json({ error: "Invalid Fundraising request." }, { status: 400 }); }
  }
  const tick = () => { if (Date.now() >= retryAt) void sync(); };
  return { handle, sync, status, start() { if (!timer) { void sync(); timer = setInterval(tick, POLL_MS); } }, stop() { clearInterval(timer); timer = undefined; } };
}
