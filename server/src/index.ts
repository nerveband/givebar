import { initDatabase } from "./db";
import { handleStateRequest, handleStateStreamRequest } from "./routes/state";
import { handleDonationRequest } from "./routes/donation";
import { handleControlRequest } from "./routes/control";
import { handleExportBackup, handleExportCSV } from "./routes/export";
import { handleHistoryRequest } from "./routes/history";
import { handleRehearsalRequest } from "./routes/rehearsal";
import { handleQRRequest } from "./routes/qr";
import { handleAssetRequest } from "./routes/asset";
import { handlePresenceRequest } from "./presence";
import { createFundraisingSync } from "./fundraising";
import { createBackupManager } from "./backup";
import { createWebStats, handleStatsRequest } from "./stats";
import { getSession, renewSessionCookie } from "./authz";
import type { OperatorRole } from "./authz";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { Database } from "bun:sqlite";

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const DB_PATH = process.env.GIVEBAR_DB_PATH || "data/givebar.sqlite";

export const db = initDatabase(DB_PATH);
const backups = createBackupManager(db, DB_PATH);
backups.start();
const fundraising = createFundraisingSync(db);
fundraising.start();
const webStats = createWebStats();

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff"
};

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  // Testing and the previews frame the chart from the same origin; nobody else may frame operator pages.
  "X-Frame-Options": "SAMEORIGIN"
};

/** JSON write bodies are small, except Settings saves that carry an uploaded image; presence enforces its own 512-byte cap. */
const MAX_API_BODY_BYTES = 65536;
const MAX_CONTROL_BODY_BYTES = 4 * 1024 * 1024;

/** A browser write that names a foreign Origin is never one of ours. */
function crossOriginWrite(req: Request, url: URL): boolean {
  if (req.method === "GET" || req.method === "HEAD") return false;
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try { return new URL(origin).host !== url.host; } catch { return true; }
}

const CLIENT_ROOT = join(process.cwd(), "client");

function serveStaticFile(relativePath: string): Response {
  const fullPath = join(CLIENT_ROOT, relativePath);
  if (!fullPath.startsWith(CLIENT_ROOT) || !existsSync(fullPath)) return new Response("Not Found", { status: 404 });
  const bytes = readFileSync(fullPath);
  const extension = fullPath.slice(fullPath.lastIndexOf("."));
  const mime = MIME_TYPES[extension] || "application/octet-stream";
  // Fonts are content-stable under a fixed filename; CSS and JS carry ?v= cache-busters; HTML is never cached.
  const cache = /\.(woff2?|ttf|otf)$/i.test(fullPath)
    ? "public, max-age=31536000, immutable"
    : /\.(css|js|mp4|webm|png|svg)$/i.test(fullPath) ? "public, max-age=300" : "no-cache, no-store, must-revalidate, max-age=0";
  return new Response(bytes, { headers: { "Content-Type": mime, "Cache-Control": cache } });
}

/** Operator pages render the sign-in screen for anyone without a session of the required role. */
function serveOperatorPage(req: Request, db: Database, file: string, roles: OperatorRole[]): Response {
  const session = getSession(req, db);
  if (!session) return serveStaticFile("public/signin.html");
  if (!roles.includes(session.role)) return serveStaticFile("public/forbidden.html");
  return serveStaticFile(file);
}

// Every page is sign-in only: the chart, presenter, and history carry donor names and live totals.
// The sign-in page itself, its static assets, and /api/control (which owns login) are the only unauthenticated surfaces.
const SIGNED_IN_PAGES: Record<string, string> = {
  "/": "public/index.html",
  "/projector": "public/stage.html",
  "/presenter": "public/emcee.html",
  "/preview": "public/preview.html",
  "/presenter-preview": "public/preview.html",
  "/donations": "public/control.html",
  "/import": "public/import.html",
  "/history": "public/history.html",
  "/stats": "public/stats.html"
};
const ANY_ROLE: OperatorRole[] = ["admin", "operator"];

const OPERATOR_PAGES: Record<string, { file: string; roles: OperatorRole[] }> = {
  "/settings": { file: "public/settings.html", roles: ["admin"] },
  "/team": { file: "public/team.html", roles: ["admin"] },
  "/testing": { file: "public/testing.html", roles: ["admin"] }
};

function withSecurity(response: Response, req: Request): Response {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(key, value);
  renewSessionCookie(req, db, response);
  return response;
}

export const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req: Request) {
    const url = new URL(req.url);
    const pathname = url.pathname.replace(/\.html$/, "").replace(/\/+$/, "") || "/";

    if (pathname.startsWith("/api/")) {
      const parts = pathname.split("/").filter(Boolean);
      const resource = parts[1];
      if (crossOriginWrite(req, url)) return withSecurity(Response.json({ error: "FORBIDDEN", message: "Cross-origin request refused" }, { status: 403 }), req);
      if (resource !== "control" && !getSession(req, db)) return withSecurity(Response.json({ error: "UNAUTHORIZED", message: "Sign in required" }, { status: 401 }), req);
      const declaredLength = Number(req.headers.get("content-length") || 0);
      if (declaredLength > (resource === "control" ? MAX_CONTROL_BODY_BYTES : MAX_API_BODY_BYTES)) return withSecurity(Response.json({ error: "PAYLOAD_TOO_LARGE", message: "Request body too large" }, { status: 413 }), req);
      if (resource === "state") return withSecurity(parts[2] === "stream" ? handleStateStreamRequest(req, db) : handleStateRequest(req, db), req);
      if (resource === "donation") return withSecurity(await handleDonationRequest(req, db, parts), req);
      if (resource === "control") return withSecurity(await handleControlRequest(req, db, backups), req);
      if (resource === "history") return withSecurity(handleHistoryRequest(req, db), req);
      if (resource === "stats") return withSecurity(await handleStatsRequest(req, db, webStats), req);
      if (resource === "export" && parts[2] === "csv") return withSecurity(handleExportCSV(req, db), req);
      if (resource === "export" && parts[2] === "backup") return withSecurity(handleExportBackup(req, db, backups), req);
      if (resource === "rehearsal") return withSecurity(await handleRehearsalRequest(req, db), req);
      if (resource === "qr") return withSecurity(handleQRRequest(req, db), req);
      if (resource === "asset") return withSecurity(handleAssetRequest(db, parts[2] || ""), req);
      if (resource === "presence") return withSecurity(await handlePresenceRequest(req, db), req);
      if (resource === "fundraising") return withSecurity(await fundraising.handle(req), req);
      return withSecurity(Response.json({ error: "NOT_FOUND", message: `API route ${pathname} not found` }, { status: 404 }), req);
    }

    if (pathname === "/signin") return withSecurity(serveStaticFile("public/signin.html"), req);
    if (pathname === "/projector" && ["1", "true"].includes(url.searchParams.get("edit") || "")) {
      return withSecurity(serveOperatorPage(req, db, "public/stage.html", ["admin"]), req);
    }
    if (SIGNED_IN_PAGES[pathname]) return withSecurity(serveOperatorPage(req, db, SIGNED_IN_PAGES[pathname], ANY_ROLE), req);
    const operatorPage = OPERATOR_PAGES[pathname];
    if (operatorPage) return withSecurity(serveOperatorPage(req, db, operatorPage.file, operatorPage.roles), req);
    if (/^\/(css|js|assets)\//.test(url.pathname)) return withSecurity(serveStaticFile(url.pathname.slice(1)), req);
    return withSecurity(new Response("Page Not Found", { status: 404 }), req);
  }
});

console.log(`[Givebar] Live fundraising server active on http://${HOST}:${PORT}`);
console.log(`  Home              http://localhost:${PORT}/`);
console.log(`  Projector         http://localhost:${PORT}/projector`);
console.log(`  Presenter         http://localhost:${PORT}/presenter`);
console.log(`  Manage Donations  http://localhost:${PORT}/donations`);
console.log(`  Backups           ${backups.dir || "disabled (in-memory database)"}`);
