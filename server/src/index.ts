import { initDatabase } from "./db";
import { handleStateRequest, handleStateStreamRequest } from "./routes/state";
import { handleDonationRequest } from "./routes/donation";
import { handleControlRequest } from "./routes/control";
import { handleExportCSV } from "./routes/export";
import { handleRehearsalRequest } from "./routes/rehearsal";
import { handleWebhookRequest } from "./routes/webhook";
import { handleQRRequest } from "./routes/qr";
import { handlePresenceRequest } from "./presence";
import { createFundraisingSync } from "./fundraising";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { Database } from "bun:sqlite";
import { getSession } from "./authz";

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const DB_PATH = process.env.GIVEBAR_DB_PATH || "data/givebar.sqlite";

// Initialize SQLite WAL Database
export const db = initDatabase(DB_PATH);
const fundraising = createFundraisingSync(db);
fundraising.start();

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

function getMimeType(filePath: string): string {
  for (const ext in MIME_TYPES) {
    if (filePath.endsWith(ext)) return MIME_TYPES[ext];
  }
  return "text/plain; charset=utf-8";
}

function serveStaticFile(relativePath: string): Response {
  const clientRoot = join(process.cwd(), "client");
  const fullPath = join(process.cwd(), relativePath);
  
  // Path traversal boundary guard
  if (!fullPath.startsWith(clientRoot)) {
    return new Response("Forbidden", { status: 403 });
  }

  if (existsSync(fullPath)) {
    const fileBytes = readFileSync(fullPath);
    const mime = getMimeType(fullPath);

    // Fonts are content-stable under a fixed filename: cache hard.
    if (/\.(woff2?|ttf|otf)$/i.test(fullPath)) {
      return new Response(fileBytes, {
        headers: { "Content-Type": mime, "Cache-Control": "public, max-age=31536000, immutable" }
      });
    }

    // CSS and JS carry a ?v= cache-busting query in every page's markup, so a deploy
    // invalidates them by URL. `no-store` forced a full refetch of all four stylesheets
    // on every navigation, which is what produced the unstyled flash between pages.
    if (/\.(css|js)$/i.test(fullPath)) {
      return new Response(fileBytes, {
        headers: { "Content-Type": mime, "Cache-Control": "public, max-age=300" }
      });
    }

    // HTML and everything else stays uncached so an operator never holds a stale surface.
    return new Response(fileBytes, {
      headers: {
        "Content-Type": mime,
        "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
        "Pragma": "no-cache",
        "Expires": "0"
      }
    });
  }
  return new Response("Not Found", { status: 404 });
}
function serveOperatorFile(req: Request, db: Database, relativePath: string): Response {
  const session = getSession(req, db);
  if (!session || (session.role !== "admin" && session.role !== "operator")) {
    return serveStaticFile("client/public/signin.html");
  }
  return serveStaticFile(relativePath);
}

export const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req: Request) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": req.headers.get("origin") || "",
          Vary: "Origin",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Allow-Credentials": "true"
        }
      });
    }
    const security: Record<string, string> = {
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
    };

    // --- API Routes ---
    if (pathname.startsWith("/api/")) {
      const parts = pathname.split("/").filter(Boolean); // ['api', 'state'] etc.

      if (parts[1] === "state") {
        const response = parts[2] === "stream" ? handleStateStreamRequest(req, db) : handleStateRequest(req, db);
        for (const [key, value] of Object.entries(security)) response.headers.set(key, value);
        return response;
      }

      let api: Response | null = null;
      if (parts[1] === "donation") api = await handleDonationRequest(req, db, parts);
      else if (parts[1] === "control") api = await handleControlRequest(req, db);
      else if (parts[1] === "export" && parts[2] === "csv") api = handleExportCSV(req, db);
      else if (parts[1] === "rehearsal") api = await handleRehearsalRequest(req, db);
      else if (parts[1] === "webhooks") api = await handleWebhookRequest(req, db, parts);
      else if (parts[1] === "qr") api = handleQRRequest(req, db);
      else if (parts[1] === "presence") api = await handlePresenceRequest(req, db);
      else if (parts[1] === "fundraising") api = await fundraising.handle(req);
      else api = Response.json({ error: "NOT_FOUND", message: `API route ${pathname} not found` }, { status: 404 });
      for (const [key, value] of Object.entries(security)) api.headers.set(key, value);
      return api;

    }

    // --- Surface Page Routes ---
    // Public ballroom display. Totals, messages, QR, funded progress, and donor chyrons are intentionally public.
    let page: Response;
    if (pathname === "/" || pathname === "/index.html") {
      page = serveStaticFile("client/public/index.html");
    } else if (pathname === "/chart" || pathname === "/chart.html" || pathname === "/stage" || pathname === "/stage.html") {
      page = serveStaticFile("client/public/stage.html");
    } else if (pathname === "/presenter" || pathname === "/presenter.html" || pathname === "/emcee" || pathname === "/emcee.html") {
      page = serveStaticFile("client/public/emcee.html");
    } else if (pathname === "/preview" || pathname === "/preview.html" || pathname === "/presenter-preview") {
      page = serveStaticFile("client/public/preview.html");
    } else if (pathname === "/donations" || pathname === "/donations.html" || pathname === "/control" || pathname === "/control.html") {
      page = serveOperatorFile(req, db, "client/public/control.html");
    } else if (pathname === "/add" || pathname === "/add.html" || pathname === "/entry" || pathname === "/entry.html") {
      return Response.redirect(new URL("/donations", req.url), 308);
    } else if (pathname === "/settings" || pathname === "/settings.html") {
      page = serveOperatorFile(req, db, "client/public/settings.html");
    } else if (pathname === "/testing" || pathname === "/testing.html") {
      page = serveOperatorFile(req, db, "client/public/testing.html");
    } else if (pathname === "/history" || pathname === "/history.html") {
      page = serveOperatorFile(req, db, "client/public/history.html");
    } else if (pathname === "/signin" || pathname === "/signin.html") {
      page = serveStaticFile("client/public/signin.html");
    } else if (pathname.startsWith("/css/") || pathname.startsWith("/js/") || pathname.startsWith("/assets/")) {
      page = serveStaticFile(join("client", pathname));
    } else {
      return new Response("Page Not Found", { status: 404 });
    }
    for (const [key, value] of Object.entries(security)) page.headers.set(key, value);
    return page;

  }
});

console.log(`[Givebar] Live fundraising server active on http://${HOST}:${PORT}`);
console.log(`  - Suite Launcher:        http://localhost:${PORT}/`);
console.log(`  - Main Ballroom Screen:  http://localhost:${PORT}/stage`);
console.log(`  - Event Control Room:    http://localhost:${PORT}/control`);
console.log(`  - Podium Screen:         http://localhost:${PORT}/emcee`);
console.log(`  - Volunteer Pledge Pad:  http://localhost:${PORT}/entry`);
