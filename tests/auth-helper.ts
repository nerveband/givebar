import type { Database } from "bun:sqlite";
import { handleControlRequest } from "../server/src/routes/control";
import { createBackupManager, type BackupManager } from "../server/src/backup";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export function backupsFor(db: Database): BackupManager {
  return createBackupManager(db, ":memory:", mkdtempSync(join(tmpdir(), "givebar-backups-")));
}

export function control(body: Record<string, unknown>, cookie?: string): Request {
  return new Request("http://localhost:3000/api/control", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body)
  });
}

export function json(path: string, body: unknown, cookie?: string, method = "POST"): Request {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body)
  });
}

export function get(path: string, cookie?: string): Request {
  return new Request(`http://localhost:3000${path}`, { headers: cookie ? { Cookie: cookie } : {} });
}

/** Bootstraps the founding administrator and returns a session cookie for the requested account. */
export async function sessionCookie(db: Database, backups: BackupManager, username = "founder", role: "admin" | "operator" = "admin"): Promise<string> {
  await handleControlRequest(control({ action: "bootstrap_admin", username: "founder", displayName: "Founding Director", pin: "1357911" }), db, backups);
  const founderLogin = await handleControlRequest(control({ action: "login", username: "founder", pin: "1357911" }), db, backups);
  const founderCookie = founderLogin.headers.get("set-cookie")!.split(";")[0];
  if (username === "founder") return founderCookie;
  await handleControlRequest(control({ action: "create_account", username, displayName: username.charAt(0).toUpperCase() + username.slice(1), pin: "2468", role }, founderCookie), db, backups);
  const login = await handleControlRequest(control({ action: "login", username, pin: "2468" }), db, backups);
  return login.headers.get("set-cookie")!.split(";")[0];
}
