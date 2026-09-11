import type { Database } from "bun:sqlite";
import nodemailer from "nodemailer";
export type OperatorRole = "admin" | "operator";
export interface OperatorSession {
  accountId: string;
  username: string;
  displayName: string;
  role: OperatorRole;
}

export const SESSION_COOKIE = "givebar_session";
const MAX_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;
const SESSION_MS = 12 * 60 * 60 * 1000;

function sha256Hex(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function sessionToken(): string {
  return crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
}

function now(): number {
  return Date.now();
}

export function normalizeUsername(value: unknown): string {
  return String(value || "").trim().toLowerCase().slice(0, 64);
}

export function getSession(req: Request, db: Database): OperatorSession | null {
  const header = req.headers.get("cookie") || "";
  const token = header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!token) return null;
  const hashed = sha256Hex(token);
  const row = db.query<{ account_id: string; expires_at: number; username: string; display_name: string; role: OperatorRole; disabled: number }, [string]>(
    `SELECT s.account_id, s.expires_at, a.username, a.display_name, a.role, a.disabled
     FROM operator_session s JOIN operator_account a ON a.id = s.account_id
     WHERE s.token_hash = ?`
  ).get(hashed);
  if (!row || row.disabled || row.expires_at < now()) {
    if (row) db.query(`DELETE FROM operator_session WHERE token_hash = ?`).run(hashed);
    return null;
  }
  return { accountId: row.account_id, username: row.username, displayName: row.display_name, role: row.role };
}

export async function login(db: Database, username: string, pin: string, ip: string): Promise<{ response: Response; accountId?: string; action?: string }> {
  const key = `${ip}:${normalizeUsername(username)}`;
  const attempt = db.query<{ attempts: number; expires_at: number }, [string]>(`SELECT attempts, expires_at FROM login_attempt WHERE key = ?`).get(key);
  if (attempt && attempt.expires_at > now() && attempt.attempts >= MAX_ATTEMPTS) {
    return { response: Response.json({ error: "LOCKED_OUT", message: "Too many sign-in attempts. Wait 15 minutes." }, { status: 429 }) };
  }
  if (attempt && attempt.expires_at <= now()) db.query(`DELETE FROM login_attempt WHERE key = ?`).run(key);

  const account = db.query<{ id: string; username: string; display_name: string; pin_hash: string; role: OperatorRole; disabled: number }, [string]>(
    `SELECT id, username, display_name, pin_hash, role, disabled FROM operator_account WHERE username = ?`
  ).get(normalizeUsername(username));
  if (!account || account.disabled || !(await Bun.password.verify(pin, account.pin_hash))) {
    const remainingAttempts = (attempt?.attempts || 0) + 1;
    db.query(`INSERT OR REPLACE INTO login_attempt (key, attempts, expires_at) VALUES (?, ?, ?)`).run(key, remainingAttempts, now() + LOCKOUT_MS);
    db.query(`INSERT INTO access_audit (actor_id, action, target_id, created_at) VALUES (?, 'login_failed', ?, ?)`).run(account ? account.id : null, username, now());
    return { response: Response.json({ error: "UNAUTHORIZED", message: "Invalid name or PIN." }, { status: 401 }) };
  }

  db.query(`DELETE FROM login_attempt WHERE key = ?`).run(key);
  db.query(`DELETE FROM operator_session WHERE account_id = ? AND expires_at < ?`).run(account.id, now());
  const raw = sessionToken();
  db.query(`INSERT INTO operator_session (token_hash, account_id, expires_at) VALUES (?, ?, ?)`).run(sha256Hex(raw), account.id, now() + SESSION_MS);
  db.query(`INSERT INTO access_audit (actor_id, action, created_at) VALUES (?, 'login', ?)`).run(account.id, now());
  return {
    response: new Response(JSON.stringify({ ok: true, username: account.username, displayName: account.display_name, role: account.role }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Set-Cookie": `${SESSION_COOKIE}=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}; Secure`
      }
    }),
    accountId: account.id,
    action: "login"
  };
}

export function logout(req: Request, db: Database): Response {
  const session = getSession(req, db);
  const header = req.headers.get("cookie") || "";
  const token = header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (token) db.query(`DELETE FROM operator_session WHERE token_hash = ?`).run(sha256Hex(token));
  if (session) db.query(`INSERT INTO access_audit (actor_id, action, created_at) VALUES (?, 'logout', ?)`).run(session.accountId, now());
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`
    }
  });
}

/** Returns the session when its role is allowed, otherwise the 401/403 response to send. */
export function requireRole(db: Database, req: Request, allowed: OperatorRole[]): OperatorSession | Response {
  const session = getSession(req, db);
  if (!session) return Response.json({ error: "UNAUTHORIZED", message: "Sign in required" }, { status: 401 });
  if (!allowed.includes(session.role)) return Response.json({ error: "FORBIDDEN", message: "Insufficient permission" }, { status: 403 });
  return session;
}

const INVITE_MS = 7 * 24 * 60 * 60 * 1000;

function brevoKey(): string {
  return process.env.BREVO_API_KEY || "";
}

function smtpConfig(): { user: string; pass: string } | null {
  const user = process.env.BREVO_SMTP_USER || "";
  const pass = process.env.BREVO_SMTP_KEY || "";
  return user && pass ? { user, pass } : null;
}

function appOrigin(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-proto");
  const proto = forwarded ? forwarded.split(",")[0].trim() : new URL(req.url).protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || new URL(req.url).host;
  return `${proto}://${host}`;
}

async function sendBrevoEmail(to: string, subject: string, html: string, text: string): Promise<void> {
  const key = brevoKey();
  if (key) {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": key },
      body: JSON.stringify({ sender: { email: "info@wavedepth.com", name: "Givebar" }, to: [{ email: to }], subject, htmlContent: html, textContent: text })
    });
    if (!response.ok) throw new Error(`Email send failed (HTTP ${response.status}).`);
    return;
  }
  const smtp = smtpConfig();
  if (!smtp) throw new Error("Email is not configured. Set BREVO_API_KEY or BREVO_SMTP_KEY.");
  const transporter = nodemailer.createTransport({ host: "smtp-relay.brevo.com", port: 587, auth: { user: smtp.user, pass: smtp.pass } });
  await transporter.sendMail({ from: "Givebar <info@wavedepth.com>", to, subject, html, text });
}

/** Plain-language steps every operator needs on the night; shared by the invite email and the team briefing. */
export const OPERATOR_STEPS = [
  "Open Manage Donations and press Add donation for every pledge card or verbal pledge. Enter the donor name and the amount, then Record donation.",
  "Check the donor name and the amount before you press Record. Gifts at or above the major-gift threshold ask you to confirm; so does a gift that looks like one already entered.",
  "Made a mistake? Press Delete on that row right away. Deleted within the staging delay, it never reaches the ballroom screen. Later deletes keep the screen total steady and the gift can be restored from History.",
  "Do not enter online gifts. They arrive automatically from the donation page every 30 seconds.",
  "Tick Anonymous on public screens when a donor asks for it. The team still sees the name; the room sees Anonymous Supporter.",
  "Use the team note field for anything the finance team should know, and Team notes on Manage Donations to talk to the other operators.",
  "If the page says Connection lost, keep it open: gifts you record are saved in the browser and sent as soon as the network returns."
];

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[ch] as string);
}

/** Mints a single-use sign-in link (7 days) for an account. Works for a text message just as well as for the email. */
export function createInviteLink(db: Database, req: Request, accountId: string): { link: string; expires_at: number; username: string; display_name: string } {
  const account = db.query<{ display_name: string; username: string; disabled: number }, [string]>(`SELECT display_name, username, disabled FROM operator_account WHERE id = ?`).get(accountId);
  if (!account) throw new Error("Operator not found.");
  if (account.disabled) throw new Error("Enable the account before issuing a sign-in link.");
  const raw = sessionToken();
  const expiresAt = now() + INVITE_MS;
  db.query(`INSERT INTO operator_invite (token_hash, account_id, expires_at) VALUES (?, ?, ?)`).run(sha256Hex(raw), accountId, expiresAt);
  return { link: `${appOrigin(req)}/signin?invite=${raw}`, expires_at: expiresAt, username: account.username, display_name: account.display_name };
}

export async function createInvite(db: Database, req: Request, accountId: string, email: string): Promise<{ link: string }> {
  const address = email.trim().slice(0, 254);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new Error("Enter a valid email address.");
  const account = db.query<{ display_name: string; username: string; role: OperatorRole }, [string]>(`SELECT display_name, username, role FROM operator_account WHERE id = ?`).get(accountId);
  if (!account) throw new Error("Operator not found.");
  const event = db.query<{ event_name: string; stage_delay_ms: number }, []>(`SELECT event_name, stage_delay_ms FROM event_state WHERE id = 1`).get()!;
  const { link } = createInviteLink(db, req, accountId);
  const origin = appOrigin(req);
  const firstName = account.display_name.split(" ")[0];
  const delaySeconds = Math.round(event.stage_delay_ms / 1000);
  const steps = OPERATOR_STEPS.map(step => step.replace("the staging delay", `${delaySeconds} seconds`));
  const roleLine = account.role === "admin"
    ? "You are an administrator: Settings, Testing, backups, and operator accounts are yours."
    : "You are an operator: you record and correct gifts on Manage Donations.";

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#070603;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;"><div style="max-width:560px;margin:0 auto;padding:32px 24px;">`
    + `<div style="text-align:center;padding:24px 0 8px;"><div style="font-size:22px;font-weight:800;letter-spacing:-0.02em;color:#f4f5f6;">Givebar</div><div style="font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#d4a359;margin-top:4px;">${escapeHtml(event.event_name)}</div></div>`
    + `<div style="background:#141519;border:1px solid #2a2c34;border-radius:12px;padding:32px 28px;margin-top:16px;color:#c9c6bd;font-size:14px;line-height:1.55;">`
    + `<h1 style="margin:0 0 8px;font-size:20px;font-weight:800;color:#f4f5f6;">Hi ${escapeHtml(firstName)}, you're on the team.</h1>`
    + `<p style="margin:0 0 16px;">${escapeHtml(roleLine)}</p>`
    + `<p style="margin:0 0 20px;"><a href="${link}" style="display:inline-block;background:#e6bd7b;color:#1a1408;font-weight:800;text-decoration:none;padding:14px 22px;border-radius:10px;">Sign in to Givebar</a></p>`
    + `<p style="margin:0 0 6px;">Your sign-in name is <strong style="color:#f4f5f6;">${escapeHtml(account.username)}</strong>. The button works once and expires in 7 days; after that, sign in at <a href="${origin}/signin" style="color:#e6bd7b;">${origin}/signin</a> with your name and PIN. You can change the PIN any time from the sign-in page.</p>`
    + `<h2 style="margin:24px 0 8px;font-size:15px;color:#f4f5f6;">What to do on the night</h2>`
    + `<ol style="margin:0;padding-left:20px;">${steps.map(step => `<li style="margin:0 0 10px;">${escapeHtml(step)}</li>`).join("")}</ol>`
    + `<h2 style="margin:24px 0 8px;font-size:15px;color:#f4f5f6;">Links</h2>`
    + `<p style="margin:0;">Manage Donations: <a href="${origin}/donations" style="color:#e6bd7b;">${origin}/donations</a><br>Home and links: <a href="${origin}/" style="color:#e6bd7b;">${origin}/</a></p>`
    + `</div><p style="margin:16px 0 0;font-size:12px;color:#6b6a63;text-align:center;">If you didn't expect this, ignore it.</p></div></body></html>`;
  const text = `Hi ${firstName},\n\n${roleLine}\n\nSign in with this one-time link (works once, expires in 7 days):\n${link}\n\nYour sign-in name is ${account.username}. Afterwards sign in at ${origin}/signin with your name and PIN.\n\nWhat to do on the night:\n${steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n\nManage Donations: ${origin}/donations\nHome and links: ${origin}/\n\nIf you didn't expect this, ignore it.`;
  await sendBrevoEmail(address, `${event.event_name}: your Givebar sign-in and steps`, html, text);
  return { link };
}

export async function redeemInvite(db: Database, token: string): Promise<Response> {
  const hashed = sha256Hex(token);
  const row = db.query<{ account_id: string; expires_at: number; used_at: number | null; username: string; display_name: string; role: OperatorRole; disabled: number }, [string]>(
    `SELECT i.account_id, i.expires_at, i.used_at, a.username, a.display_name, a.role, a.disabled
     FROM operator_invite i JOIN operator_account a ON a.id = i.account_id WHERE i.token_hash = ?`
  ).get(hashed);
  if (!row || row.used_at || row.expires_at < now() || row.disabled) {
    return Response.json({ error: "INVALID_INVITE", message: "That invite link is invalid, expired, or already used." }, { status: 400 });
  }
  db.query(`UPDATE operator_invite SET used_at = ? WHERE token_hash = ?`).run(now(), hashed);
  db.query(`DELETE FROM operator_session WHERE account_id = ?`).run(row.account_id);
  const raw = sessionToken();
  db.query(`INSERT INTO operator_session (token_hash, account_id, expires_at) VALUES (?, ?, ?)`).run(sha256Hex(raw), row.account_id, now() + SESSION_MS);
  db.query(`INSERT INTO access_audit (actor_id, action, created_at) VALUES (?, 'invite_redeemed', ?)`).run(row.account_id, now());
  return new Response(JSON.stringify({ ok: true, username: row.username, displayName: row.display_name, role: row.role }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Set-Cookie": `${SESSION_COOKIE}=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}; Secure` }
  });
}

export async function changePin(db: Database, req: Request, currentPin: string, nextPin: string): Promise<Response> {
  const session = getSession(req, db);
  if (!session) return Response.json({ error: "UNAUTHORIZED", message: "Sign in required" }, { status: 401 });
  if (nextPin.length < 4 || nextPin.length > 12) return Response.json({ error: "INVALID_PIN", message: "PIN must be 4-12 characters." }, { status: 400 });
  const account = db.query<{ pin_hash: string }, [string]>(`SELECT pin_hash FROM operator_account WHERE id = ?`).get(session.accountId);
  if (!account || !(await Bun.password.verify(currentPin, account.pin_hash))) {
    return Response.json({ error: "UNAUTHORIZED", message: "Current PIN is incorrect." }, { status: 401 });
  }
  db.query(`UPDATE operator_account SET pin_hash = ? WHERE id = ?`).run(await Bun.password.hash(nextPin), session.accountId);
  db.query(`DELETE FROM operator_session WHERE account_id = ?`).run(session.accountId);
  const raw = sessionToken();
  db.query(`INSERT INTO operator_session (token_hash, account_id, expires_at) VALUES (?, ?, ?)`).run(sha256Hex(raw), session.accountId, now() + SESSION_MS);
  db.query(`INSERT INTO access_audit (actor_id, action, created_at) VALUES (?, 'pin_changed', ?)`).run(session.accountId, now());
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Set-Cookie": `${SESSION_COOKIE}=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}; Secure` }
  });
}
