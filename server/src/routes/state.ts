import type { Database } from "bun:sqlite";
import { getStageState, getEmceeState, getControlState, getVolunteerState, getEventState, foldLedger } from "../ledger";

export function getStatePayload(role: string, db: Database, sinceSeq = 0, volunteerId?: string, pin?: string): { status: number; payload: unknown } {
  switch (role) {
    case "stage":
      return { status: 200, payload: getStageState(db, sinceSeq) };
    case "emcee":
      return { status: 200, payload: getEmceeState(db) };
    case "control": {
      const eventState = getEventState(db);
      const isAuthDisabled = process.env.GIVEBAR_DISABLE_AUTH === "1" || process.env.NODE_ENV === "test";
      if (!isAuthDisabled && eventState.control_pin && eventState.control_pin.trim() !== "" && pin !== eventState.control_pin) {
        return { status: 401, payload: { error: "UNAUTHORIZED", message: "Control Room PIN required" } };
      }
      return { status: 200, payload: getControlState(db) };
    }
    case "entry":
      return { status: 200, payload: getVolunteerState(db, volunteerId) };
    default: {
      const fullState = getEventState(db);
      const { control_pin: _c, entry_pin: _e, bloomerang_api_key: _b, ...sanitizedEvent } = fullState;
      const hasBloomerangKey = Boolean(fullState.bloomerang_api_key && fullState.bloomerang_api_key.trim() !== "");
      return {
        status: 200,
        payload: {
          stage: getStageState(db, sinceSeq),
          event: {
            ...sanitizedEvent,
            has_bloomerang_api_key: hasBloomerangKey,
            bloomerang_key_masked: hasBloomerangKey ? "••••••••••••••" : ""
          },
          folded: foldLedger(db)
        }
      };
    }
  }
}

export function handleStateRequest(req: Request, db: Database): Response {
  const url = new URL(req.url);
  const role = url.searchParams.get("role") || "stage";
  const sinceSeq = parseInt(url.searchParams.get("since") || "0", 10);
  const volunteerId = url.searchParams.get("volunteer_id") || undefined;
  const pin = req.headers.get("X-Control-Pin") || url.searchParams.get("pin") || "";

  const { status, payload } = getStatePayload(role, db, sinceSeq, volunteerId, pin);

  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    }
  });
}

export function handleStateStreamRequest(req: Request, db: Database): Response {
  const url = new URL(req.url);
  const role = url.searchParams.get("role") || "stage";
  const volunteerId = url.searchParams.get("volunteer_id") || undefined;
  let timerId: Timer | number | null = null;

  let lastSentHash = "";

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      const sendUpdate = () => {
        try {
          const { status, payload } = getStatePayload(role, db, 0, volunteerId, pin);
          if (status !== 200) {
            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(payload)}\n\n`));
            controller.close();
            if (timerId) clearInterval(timerId);
            return;
          }

          const serialized = JSON.stringify(payload);
          if (serialized !== lastSentHash) {
            lastSentHash = serialized;
            controller.enqueue(encoder.encode(`data: ${serialized}\n\n`));
          } else {
            // Heartbeat comment to keep HTTP connection fresh
            controller.enqueue(encoder.encode(`: ping\n\n`));
          }
        } catch {
          if (timerId) clearInterval(timerId);
          try { controller.close(); } catch {}
        }
      };

      sendUpdate();
      timerId = setInterval(sendUpdate, 350);
    },
    cancel() {
      if (timerId) {
        clearInterval(timerId);
        timerId = null;
      }
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
