import type { Database } from "bun:sqlite";
import { getSession } from "./authz";

/**
 * Live Presence Registry
 * ----------------------
 * Who is connected, and to which surface. Purely operational: it answers
 * "is the ballroom projector still attached?" mid-appeal, which is the moment
 * a silent drop becomes an emergency.
 *
 * IN-MEMORY, DELIBERATELY. Presence is ephemeral and high-frequency. It never
 * touches the append-only ledger and never adds write load: a heartbeat is a
 * Map set, nothing more. A restart rebuilds the whole roster inside one
 * heartbeat interval, which is the correct trade.
 *
 * EXPIRY IS EVALUATED ON READ. A registry that only prunes on write shows a
 * phantom operator after the last laptop closes — precisely the failure this
 * feature exists to catch. Every read sweeps first.
 *
 * PRIVACY. An entry carries a display name, a surface, a coarse device class,
 * and two timestamps. No donor data, no PINs, no API keys, and never the raw
 * user-agent string.
 */

export const PRESENCE_TTL_MS = 15_000;
export const PRESENCE_HEARTBEAT_MS = 5_000;

/** A heartbeat is four short fields; anything larger is not a heartbeat. */
const MAX_BODY_BYTES = 1024;
const MAX_CLIENT_ID_LENGTH = 64;
const MAX_NAME_LENGTH = 32;
const MAX_RAW_NAME_LENGTH = 96;
/** Hard ceiling so a hostile client cannot grow the registry without bound. */
const MAX_ENTRIES = 250;

/**
 * Canonical route names. Legacy aliases resolve to these before they arrive.
 * The Record is the membership check; the array exists for error copy.
 */
const SURFACE_ALLOWED: Record<string, true> = {
  home: true,
  chart: true,
  donations: true,
  add: true,
  presenter: true,
  settings: true,
  testing: true,
  history: true,
  preview: true
};

export const PRESENCE_SURFACES = Object.keys(SURFACE_ALLOWED) as PresenceSurface[];

export type PresenceSurface =
  | "home"
  | "chart"
  | "donations"
  | "add"
  | "presenter"
  | "settings"
  | "testing"
  | "history"
  | "preview";
export type DeviceClass = "desktop" | "tablet" | "phone";

export interface PresenceEntry {
  client_id: string;
  name: string;
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

/**
 * Coarse device class, derived here from the request user-agent rather than
 * trusted from the body. Three buckets is all an operator needs, and the raw
 * string is discarded immediately so the registry stays non-identifying.
 *
 * Tablets are matched first: an iPad reports "Mobile" too.
 */
export function classifyDevice(userAgent: string | null | undefined): DeviceClass {
  const ua = typeof userAgent === "string" ? userAgent : "";
  if (ua === "") return "desktop";
  if (/iPad|Tablet|PlayBook|Silk|Kindle|Nexus (?:7|9|10)|SM-T|GT-P/i.test(ua)) return "tablet";
  if (/Android(?!.*Mobile)/i.test(ua)) return "tablet";
  if (/Mobi|iPhone|iPod|Android|Windows Phone|IEMobile|BlackBerry|Opera Mini/i.test(ua)) return "phone";
  return "desktop";
}

/** Opaque handle: url-safe characters only, so it can never carry markup. */
function sanitizeClientId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length < 4 || trimmed.length > MAX_CLIENT_ID_LENGTH) return null;
  if (!/^[A-Za-z0-9_.:-]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Display names are typed by operators, so they are scrubbed rather than
 * rejected: control characters and markup delimiters out, whitespace
 * collapsed, then capped. A name that is nothing but junk is a 400.
 */
function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length > MAX_RAW_NAME_LENGTH) return null;
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/[<>&"'`\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") return null;
  return cleaned.slice(0, MAX_NAME_LENGTH);
}

/** Drops every entry whose last heartbeat is older than the TTL. */
function sweep(now: number): void {
  for (const [id, entry] of registry) {
    if (now - entry.last_seen > PRESENCE_TTL_MS) registry.delete(id);
  }
}

export interface HeartbeatInput {
  client_id: unknown;
  name: unknown;
  surface: unknown;
}

export type HeartbeatResult =
  | { ok: true; entry: PresenceEntry }
  | { ok: false; error: string; message: string };

/**
 * Records one heartbeat. Second heartbeat from a known client id updates the
 * existing entry — surface, name and last_seen move, first_seen does not, so
 * "connected since" survives navigation between surfaces.
 */
export function recordHeartbeat(
  input: HeartbeatInput,
  userAgent: string | null | undefined,
  now: number = Date.now()
): HeartbeatResult {
  const clientId = sanitizeClientId(input.client_id);
  if (!clientId) {
    return { ok: false, error: "INVALID_CLIENT_ID", message: "client_id must be 4-64 url-safe characters" };
  }

  const name = sanitizeName(input.name);
  if (!name) {
    return { ok: false, error: "INVALID_NAME", message: `name must be 1-${MAX_NAME_LENGTH} printable characters` };
  }

  if (!isPresenceSurface(input.surface)) {
    return {
      ok: false,
      error: "INVALID_SURFACE",
      message: `surface must be one of: ${PRESENCE_SURFACES.join(", ")}`
    };
  }

  sweep(now);

  const existing = registry.get(clientId);
  if (!existing && registry.size >= MAX_ENTRIES) {
    return { ok: false, error: "PRESENCE_FULL", message: "Too many connected clients" };
  }

  const entry: PresenceEntry = {
    client_id: clientId,
    name,
    surface: input.surface,
    device: classifyDevice(userAgent),
    first_seen: existing ? existing.first_seen : now,
    last_seen: now
  };
  registry.set(clientId, entry);
  return { ok: true, entry };
}

/**
 * The roster. Sweeps before reading, so a dead entry never lingers just
 * because no write happened.
 *
 * Timestamps are absolute and nothing here is relative to "now": the SSE
 * stream dedupes on the serialized payload, so a payload that changed every
 * tick would turn a 350ms keep-alive into a 350ms broadcast. Relative ages are
 * the client's job.
 */
export function getPresenceView(now: number = Date.now()): PresenceView {
  sweep(now);
  const entries = Array.from(registry.values()).sort((a, b) => {
    if (a.surface !== b.surface) return a.surface < b.surface ? -1 : 1;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.client_id < b.client_id ? -1 : 1;
  });
  return {
    count: entries.length,
    ttl_ms: PRESENCE_TTL_MS,
    heartbeat_ms: PRESENCE_HEARTBEAT_MS,
    entries
  };
}

/** Test and restart hygiene: the registry is process state, not event state. */
export function resetPresence(): void {
  registry.clear();
}

export function isPresenceReadable(db: Database, req: Request): boolean {
  const session = getSession(req, db);
  return Boolean(session && (session.role === "admin" || session.role === "operator"));
}

const NO_STORE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Pragma": "no-cache",
  "Expires": "0"
};

/**
 * POST /api/presence — heartbeat. GET /api/presence — roster.
 *
 * The POST path touches no database at all: validate, then one Map write. The
 * GET path reads a single PIN column to apply the auth rule, and the roster
 * itself is in-memory.
 */
export async function handlePresenceRequest(req: Request, db: Database): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "GET") {
    if (!isPresenceReadable(db, req)) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED", message: "Operator sign-in required" }), {
        status: 401,
        headers: NO_STORE_HEADERS
      });
    }
    const now = Date.now();
    return new Response(JSON.stringify({ ...getPresenceView(now), now }), { status: 200, headers: NO_STORE_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "METHOD_NOT_ALLOWED", message: "Use POST to heartbeat" }), {
      status: 405,
      headers: { ...NO_STORE_HEADERS, Allow: "GET, POST" }
    });
  }

  const declaredLength = parseInt(req.headers.get("Content-Length") || "0", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ error: "PAYLOAD_TOO_LARGE", message: "Heartbeat body too large" }), {
      status: 413,
      headers: NO_STORE_HEADERS
    });
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return new Response(JSON.stringify({ error: "MALFORMED_BODY", message: "Body unreadable" }), {
      status: 400,
      headers: NO_STORE_HEADERS
    });
  }

  // A missing Content-Length cannot be trusted, so the real bytes are checked too.
  if (raw.length > MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ error: "PAYLOAD_TOO_LARGE", message: "Heartbeat body too large" }), {
      status: 413,
      headers: NO_STORE_HEADERS
    });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response(JSON.stringify({ error: "MALFORMED_BODY", message: "Body must be JSON" }), {
      status: 400,
      headers: NO_STORE_HEADERS
    });
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return new Response(JSON.stringify({ error: "MALFORMED_BODY", message: "Body must be a JSON object" }), {
      status: 400,
      headers: NO_STORE_HEADERS
    });
  }

  const fields = body as Record<string, unknown>;
  const now = Date.now();
  const result = recordHeartbeat(
    { client_id: fields.client_id, name: fields.name, surface: fields.surface },
    req.headers.get("User-Agent"),
    now
  );

  if (!result.ok) {
    const status = result.error === "PRESENCE_FULL" ? 429 : 400;
    return new Response(JSON.stringify({ error: result.error, message: result.message }), {
      status,
      headers: NO_STORE_HEADERS
    });
  }

  // Deliberately thin: the roster travels on the state channel the operator
  // surfaces already hold open. Echoing the resolved name lets a client see
  // what the server actually stored, and `now` lets it correct clock skew
  // before rendering relative ages.
  return new Response(
    JSON.stringify({
      ok: true,
      now,
      name: result.entry.name,
      surface: result.entry.surface,
      device: result.entry.device,
      ttl_ms: PRESENCE_TTL_MS,
      heartbeat_ms: PRESENCE_HEARTBEAT_MS
    }),
    { status: 200, headers: NO_STORE_HEADERS }
  );
}
