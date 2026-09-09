import type { Database } from "bun:sqlite";
import { getStageState, getEmceeState, getControlState, getVolunteerState, getEventState, foldLedger } from "../ledger";
import { sanitizeEventState } from "../projection";
import { getPresenceView } from "../presence";
import { getSession } from "../authz";

export function getStatePayload(role: string, db: Database, sinceSeq = 0, req?: Request): { status: number; payload: unknown } {
  const session = req ? getSession(req, db) : null;
  const operator = session && (session.role === "admin" || session.role === "operator") ? session : null;
  switch (role) {
    case "stage":
      return { status: 200, payload: getStageState(db, sinceSeq) };
    case "emcee":
      return { status: 200, payload: getEmceeState(db) };
    case "control": {
      if (!operator) {
        return { status: 401, payload: { error: "UNAUTHORIZED", message: "Operator sign-in required" } };
      }
      return { status: 200, payload: { ...getControlState(db), presence: getPresenceView(), me: { username: operator.username, displayName: operator.displayName, role: operator.role } } };
    }
    case "entry":
      if (!operator) {
        return { status: 401, payload: { error: "UNAUTHORIZED", message: "Operator sign-in required" } };
      }
      return { status: 200, payload: getVolunteerState(db, operator.accountId) };
    default: {
      const fullState = getEventState(db);
      const hasBloomerangKey = Boolean(fullState.bloomerang_api_key && fullState.bloomerang_api_key.trim() !== "");
      const presence = operator ? getPresenceView() : undefined;
      return {
        status: 200,
        payload: {
          stage: getStageState(db, sinceSeq),
          event: {
            ...sanitizeEventState(fullState),
            has_operator_accounts: db.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM operator_account WHERE disabled = 0`).get()?.count !== 0,
            has_bloomerang_api_key: hasBloomerangKey,
            bloomerang_key_masked: hasBloomerangKey ? "••••••••••••••" : ""
          },
          folded: foldLedger(db),
          ...(presence ? { presence } : {})
        }
      };
    }
  }
}

export function handleStateRequest(req: Request, db: Database): Response {
  const url = new URL(req.url);
  const role = url.searchParams.get("role") || "stage";
  const sinceSeq = parseInt(url.searchParams.get("since") || "0", 10);

  const { status, payload } = getStatePayload(role, db, sinceSeq, req);

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
  let timerId: Timer | number | null = null;

  let lastSentHash = "";

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      const sendUpdate = () => {
        try {
          const { status, payload } = getStatePayload(role, db, 0, req);
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
