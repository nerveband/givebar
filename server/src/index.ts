import { initDatabase } from "./db";
import { handleStateRequest } from "./routes/state";
import { handleDonationRequest } from "./routes/donation";
import { handleControlRequest } from "./routes/control";
import { handleExportCSV } from "./routes/export";
import { handleRehearsalRequest } from "./routes/rehearsal";
import { handleWebhookRequest } from "./routes/webhook";
import { handleQRRequest } from "./routes/qr";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const DB_PATH = process.env.GIVEBAR_DB_PATH || "data/givebar.sqlite";

// Initialize SQLite WAL Database
export const db = initDatabase(DB_PATH);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
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
  const fullPath = join(process.cwd(), relativePath);
  if (existsSync(fullPath)) {
    const fileBytes = readFileSync(fullPath);
    return new Response(fileBytes, {
      headers: {
        "Content-Type": getMimeType(fullPath),
        "Cache-Control": relativePath.includes("/public/") ? "no-cache" : "public, max-age=3600"
      }
    });
  }
  return new Response("Not Found", { status: 404 });
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
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Control-Pin, Authorization"
        }
      });
    }

    // --- API Routes ---
    if (pathname.startsWith("/api/")) {
      const parts = pathname.split("/").filter(Boolean); // ['api', 'state'] etc.

      if (parts[1] === "state") {
        return handleStateRequest(req, db);
      }

      if (parts[1] === "donation") {
        return handleDonationRequest(req, db, parts);
      }

      if (parts[1] === "control") {
        return handleControlRequest(req, db);
      }

      if (parts[1] === "export" && parts[2] === "csv") {
        return handleExportCSV(req, db);
      }

      if (parts[1] === "rehearsal") {
        return handleRehearsalRequest(req, db);
      }

      if (parts[1] === "webhooks") {
        return handleWebhookRequest(req, db, parts);
      }

      if (parts[1] === "qr") {
        return handleQRRequest(req);
      }

      return Response.json({ error: "NOT_FOUND", message: `API route ${pathname} not found` }, { status: 404 });
    }

    // --- Surface Page Routes ---
    if (pathname === "/" || pathname === "/index.html") {
      return serveStaticFile("client/public/control.html");
    }

    if (pathname === "/stage" || pathname === "/stage.html") {
      return serveStaticFile("client/public/stage.html");
    }

    if (pathname === "/entry" || pathname === "/entry.html") {
      return serveStaticFile("client/public/entry.html");
    }

    if (pathname === "/control" || pathname === "/control.html") {
      return serveStaticFile("client/public/control.html");
    }

    if (pathname === "/emcee" || pathname === "/emcee.html") {
      return serveStaticFile("client/public/emcee.html");
    }

    // --- Static Asset Serving (CSS, JS, Assets) ---
    if (pathname.startsWith("/css/")) {
      return serveStaticFile(join("client", pathname));
    }

    if (pathname.startsWith("/js/")) {
      return serveStaticFile(join("client", pathname));
    }

    if (pathname.startsWith("/assets/")) {
      return serveStaticFile(join("client", pathname));
    }

    return new Response("Page Not Found", { status: 404 });
  }
});

console.log(`[Givebar] Live fundraising server active on http://${HOST}:${PORT}`);
console.log(`  - Stage HUD:             http://localhost:${PORT}/stage`);
console.log(`  - Volunteer Terminal:    http://localhost:${PORT}/entry`);
console.log(`  - AV & Admin Cockpit:    http://localhost:${PORT}/control`);
console.log(`  - Emcee Confidence View: http://localhost:${PORT}/emcee`);
