import type { Database } from "bun:sqlite";
import nodemailer from "nodemailer";
export type OperatorRole = "admin" | "operator" | "presenter" | "display";
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

/** Role hierarchy: admin > operator > presenter > display. */
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

export async function createInvite(db: Database, req: Request, accountId: string, email: string): Promise<{ link: string }> {
  const address = email.trim().slice(0, 254);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new Error("Enter a valid email address.");
  const raw = sessionToken();
  db.query(`INSERT INTO operator_invite (token_hash, account_id, expires_at) VALUES (?, ?, ?)`).run(sha256Hex(raw), accountId, now() + INVITE_MS);
  const link = `${appOrigin(req)}/signin.html?invite=${raw}`;
  const account = db.query<{ display_name: string; username: string }, [string]>(`SELECT display_name, username FROM operator_account WHERE id = ?`).get(accountId);
  const name = account?.display_name || "operator";
  const firstName = name.split(" ")[0];
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#070603;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;"><div style="max-width:560px;margin:0 auto;padding:32px 24px;"><div style="text-align:center;padding:24px 0 8px;"><div style="font-size:22px;font-weight:800;letter-spacing:-0.02em;color:#f4f5f6;">Givebar</div><div style="font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#d4a359;margin-top:4px;">Live Gala Fundraising</div></div><div style="background:#141519;border:1px solid #2a2c34;border-radius:12px;padding:32px 28px;margin-top:16px;"><h1 style="margin:0 0 8px;font-size:20px;font-weight:800;color:#f4f5f6;">Hi ${firstName}, you're on the team.</h1><p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#c4c6cc;">Your Givebar operator account is ready. Tap the button below to sign in — the link works <strong style="color:#f4f5f6;">once</strong> and expires in <strong style="color:#f4f5f6;">7 days</strong>.</p><div style="text-align:center;margin:24px 0;"><a href="${link}" style="display:inline-block;background:#d4a359;color:#121316;font-weight:800;font-size:15px;text-decoration:none;padding:14px 36px;border-radius:8px;">Sign in to Givebar</a></div><p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#88888e;">After signing in, you can change your PIN anytime from the sign-in page. Your sign-in name is <strong style="color:#c4c6cc;">${account?.username || ""}</strong>.</p><p style="margin:0;font-size:13px;line-height:1.6;color:#88888e;">If you didn't expect this invite, just ignore it — the link dies unused.</p></div><p style="text-align:center;font-size:11px;color:#55575f;margin-top:20px;">Sent by your event team via Givebar · CAIR-Georgia 10th Annual Gala Fundraiser</p></div></body></html>`;
  const text = `Hi ${firstName},\n\nYour Givebar operator account is ready. Sign in with this one-time link (works once, expires in 7 days):\n${link}\n\nYour sign-in name is ${account?.username || ""}. After signing in you can change your PIN anytime.\n\nIf you didn't expect this, ignore it.`;
  await sendBrevoEmail(address, "You're on the Givebar team — sign in here", html, text);
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
