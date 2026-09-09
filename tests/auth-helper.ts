import type { Database } from "bun:sqlite";
import { handleControlRequest } from "../server/src/routes/control";

export function controlRequest(body: Record<string, unknown>, cookie?: string): Request {
  return new Request("http://localhost:3000/api/control", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body)
  });
}

export function authed(req: Request, cookie: string): Request {
  const headers = new Headers(req.headers);
  headers.set("Cookie", cookie);
  return new Request(req, { headers });
}

/** Bootstrap one admin and return the requested operator session cookie. */
export async function operatorCookie(db: Database, username = "director", pin = "8271", role = "operator"): Promise<string> {
  await handleControlRequest(controlRequest({ action: "bootstrap_admin", username: "founder", displayName: "Founding Director", pin: "1357911" }), db);
  const founderLogin = await handleControlRequest(controlRequest({ action: "login", username: "founder", pin: "1357911" }), db);
  const founderCookie = founderLogin.headers.get("set-cookie")?.split(";")[0] || "";
  if (username !== "founder") {
    await handleControlRequest(controlRequest({ action: "create_account", username, displayName: username, pin, role }, founderCookie), db);
  }
  const login = await handleControlRequest(controlRequest({ action: "login", username, pin }), db);
  return login.headers.get("set-cookie")?.split(";")[0] || founderCookie;
}
