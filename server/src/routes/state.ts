import type { Database } from "bun:sqlite";
import { getStageState, getEmceeState, getControlState, getEntryState } from "../projection";
import { getSession } from "../authz";

const NO_STORE = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Pragma": "no-cache",
  "Expires": "0"
};

/** Public viewing uses privacy-filtered projections; editing remains session-gated. */
export function getStatePayload(role: string, db: Database, req: Request): { status: number; payload: unknown } {
  if (role === "stage") return { status: 200, payload: getStageState(db) };
  if (role === "emcee") return { status: 200, payload: getEmceeState(db) };
  if (role !== "control" && role !== "entry") return { status: 400, payload: { error: "INVALID_ROLE", message: "role must be stage, emcee, control, or entry" } };
  const session = getSession(req, db);
  if (role === "entry") {
    if (!session) return { status: 401, payload: { error: "UNAUTHORIZED", message: "Sign in to edit donations" } };
    return { status: 200, payload: getEntryState(db) };
  }
  const state = getControlState(db);
  if (!session) {
    return { status: 200, payload: {
      ...state, can_edit: false, me: null, team_notes: [],
      donations: state.donations.map(record => ({
        donation_id: Bun.hash(record.donation_id).toString(36),
        donor_name: record.is_anonymous ? "Anonymous Supporter" : record.display_name,
        display_name: record.is_anonymous ? "Anonymous Supporter" : record.display_name,
        amount_cents: record.amount_cents, matched_amount_cents: record.matched_amount_cents,
        is_anonymous: record.is_anonymous, payment_method: record.payment_method,
        source: record.source, created_at: record.created_at,
        is_live_on_stage: record.is_live_on_stage, is_held: record.is_held
      }))
    } };
  }
  return { status: 200, payload: { ...state, can_edit: true, me: { accountId: session.accountId, username: session.username, displayName: session.displayName, role: session.role } } };
}

export function handleStateRequest(req: Request, db: Database): Response {
  const role = new URL(req.url).searchParams.get("role") || "stage";
  const { status, payload } = getStatePayload(role, db, req);
  return new Response(JSON.stringify(payload), { status, headers: NO_STORE });
}

const STREAM_TICK_MS = 500;
const STREAM_PING_TICKS = 4;

/**
 * Server-sent state. A frame goes out only when the projection changed
 * (server_time excluded from the comparison); a lightweight ping event keeps
 * clients able to tell "quiet" from "disconnected".
 */
export function handleStateStreamRequest(req: Request, db: Database): Response {
  const role = new URL(req.url).searchParams.get("role") || "stage";
  const encoder = new TextEncoder();
  let timer: Timer | undefined;
  let lastKey = "";
  let ticks = 0;

  const stream = new ReadableStream({
    start(controller) {
      const stop = () => {
        clearInterval(timer);
        try { controller.close(); } catch { /* already closed */ }
      };
      const tick = () => {
        try {
          const { status, payload } = getStatePayload(role, db, req);
          if (status !== 200) {
            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(payload)}\n\n`));
            stop();
            return;
          }
          const { server_time, ...comparable } = payload as { server_time: number };
          const key = JSON.stringify(comparable);
          ticks++;
          if (key !== lastKey) {
            lastKey = key;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
          } else if (ticks % STREAM_PING_TICKS === 0) {
            controller.enqueue(encoder.encode(`event: ping\ndata: {"server_time":${server_time}}\n\n`));
          }
        } catch {
          stop();
        }
      };
      tick();
      timer = setInterval(tick, STREAM_TICK_MS);
    },
    cancel() {
      clearInterval(timer);
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}
