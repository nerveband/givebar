import type { Database } from "bun:sqlite";
import { getSession, type OperatorSession } from "./authz";

/**
 * Live Presence Registry
 * ----------------------
 * Who is connected, and to which operator page. Purely operational and kept
 * in memory: a heartbeat is a Map set, never a ledger write. A restart
 * rebuilds the whole roster inside one heartbeat interval.
 *
 * Identity comes from the operator session, never from the browser, so the
 * roster shows the same names the ledger records. Expiry is evaluated on
 * every read so a closed laptop disappears without waiting for a write.
 */

export const PRESENCE_TTL_MS = 15_000;
export const PRESENCE_HEARTBEAT_MS = 5_000;

const MAX_BODY_BYTES = 512;
const MAX_CLIENT_ID_LENGTH = 64;
/** Hard ceiling so a runaway client cannot grow the registry without bound. */
const MAX_ENTRIES = 250;

const SURFACE_ALLOWED: Record<string, true> = {
  home: true,
  donations: true,
  settings: true,
  testing: true,
  history: true,
  preview: true
};

export const PRESENCE_SURFACES = Object.keys(SURFACE_ALLOWED) as PresenceSurface[];
export type PresenceSurface = "home" | "donations" | "settings" | "testing" | "history" | "preview";
export type DeviceClass = "desktop" | "tablet" | "phone";

export interface PresenceEntry {
  client_id: string;
  account_id: string;
  name: string;
  role: OperatorSession["role"];
  surface: PresenceSurface;
  device: DeviceClass;
  first_seen: number;
  last_seen: number;
}

export interface PresenceView {
  count: number;
  ttl_ms: number;
  heartbeat_ms: number;
  entries: PresenceEntry[];
}

const registry = new Map<string, PresenceEntry>();

export function isPresenceSurface(value: unknown): value is PresenceSurface {
  return typeof value === "string" && SURFACE_ALLOWED[value] === true;
}

/** Coarse device class from the user-agent; the raw string never leaves the server. */
export function classifyDevice(userAgent: string | null | undefined): DeviceClass {
  const ua = typeof userAgent === "string" ? userAgent : "";
  if (ua === "") return "desktop";
  if (/iPad|Tablet|PlayBook|Silk|Kindle|Nexus (?:7|9|10)|SM-T|GT-P/i.test(ua)) return "tablet";
  if (/Android(?!.*Mobile)/i.test(ua)) return "tablet";
  if (/Mobi|iPhone|iPod|Android|Windows Phone|IEMobile|BlackBerry|Opera Mini/i.test(ua)) return "phone";
  return "desktop";
}

function sweep(now: number): void {
  for (const [id, entry] of registry) {
    if (now - entry.last_seen > PRESENCE_TTL_MS) registry.delete(id);
  }
}

export interface HeartbeatInput {
  client_id: unknown;
  surface: unknown;
}

export type HeartbeatResult =
  | { ok: true; entry: PresenceEntry }
  | { ok: false; error: string; message: string };

/** Records one heartbeat. A known client id keeps its first_seen so "connected since" survives navigation. */
export function recordHeartbeat(input: HeartbeatInput, session: OperatorSession, userAgent: string | null | undefined, now: number = Date.now()): HeartbeatResult {
  const clientId = typeof input.client_id === "string" ? input.client_id.trim() : "";
  if (clientId.length < 4 || clientId.length > MAX_CLIENT_ID_LENGTH || !/^[A-Za-z0-9_.:-]+$/.test(clientId)) {
    return { ok: false, error: "INVALID_CLIENT_ID", message: "client_id must be 4-64 url-safe characters" };
  }
  if (!isPresenceSurface(input.surface)) {
    return { ok: false, error: "INVALID_SURFACE", message: `surface must be one of: ${PRESENCE_SURFACES.join(", ")}` };
  }
  sweep(now);
  const existing = registry.get(clientId);
  if (!existing && registry.size >= MAX_ENTRIES) {
    return { ok: false, error: "PRESENCE_FULL", message: "Too many connected clients" };
  }
  const entry: PresenceEntry = {
    client_id: clientId,
    account_id: session.accountId,
    name: session.displayName,
    role: session.role,
    surface: input.surface,
    device: classifyDevice(userAgent),
    first_seen: existing ? existing.first_seen : now,
    last_seen: now
  };
  registry.set(clientId, entry);
  return { ok: true, entry };
}

/** The roster, swept first so a dead entry never lingers because no write happened. */
export function getPresenceView(now: number = Date.now()): PresenceView {
  sweep(now);
  const entries = Array.from(registry.values()).sort((a, b) => {
    if (a.surface !== b.surface) return a.surface < b.surface ? -1 : 1;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.client_id < b.client_id ? -1 : 1;
  });
  return { count: entries.length, ttl_ms: PRESENCE_TTL_MS, heartbeat_ms: PRESENCE_HEARTBEAT_MS, entries };
}

/** Test and restart hygiene: the registry is process state, not event state. */
export function resetPresence(): void {
  registry.clear();
}

const NO_STORE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Pragma": "no-cache",
  "Expires": "0"
};

function reply(status: number, body: unknown, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...NO_STORE_HEADERS, ...extra } });
}

/** POST /api/presence records a heartbeat; GET /api/presence returns the roster. Both need a session. */
export async function handlePresenceRequest(req: Request, db: Database): Promise<Response> {
  const session = getSession(req, db);
  if (!session) return reply(401, { error: "UNAUTHORIZED", message: "Operator sign-in required" });

  const now = Date.now();
  if (req.method === "GET") return reply(200, { ...getPresenceView(now), now });
  if (req.method !== "POST") return reply(405, { error: "METHOD_NOT_ALLOWED", message: "Use POST to heartbeat" }, { Allow: "GET, POST" });

  const declaredLength = parseInt(req.headers.get("Content-Length") || "0", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return reply(413, { error: "PAYLOAD_TOO_LARGE", message: "Heartbeat body too large" });

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return reply(400, { error: "MALFORMED_BODY", message: "Body unreadable" });
  }
  if (raw.length > MAX_BODY_BYTES) return reply(413, { error: "PAYLOAD_TOO_LARGE", message: "Heartbeat body too large" });

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return reply(400, { error: "MALFORMED_BODY", message: "Body must be JSON" });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return reply(400, { error: "MALFORMED_BODY", message: "Body must be a JSON object" });

  const fields = body as Record<string, unknown>;
  const result = recordHeartbeat({ client_id: fields.client_id, surface: fields.surface }, session, req.headers.get("User-Agent"), now);
  if (!result.ok) return reply(result.error === "PRESENCE_FULL" ? 429 : 400, { error: result.error, message: result.message });
  return reply(200, { ok: true, now, name: result.entry.name, surface: result.entry.surface, device: result.entry.device, ...getPresenceView(now) });
}
