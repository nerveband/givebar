import type { Database } from "bun:sqlite";
import { getStageState, getEmceeState, getControlState, getVolunteerState, getEventState, foldLedger } from "../ledger";

export function handleStateRequest(req: Request, db: Database): Response {
  const url = new URL(req.url);
  const role = url.searchParams.get("role") || "stage";
  const sinceSeq = parseInt(url.searchParams.get("since") || "0", 10);
  const volunteerId = url.searchParams.get("volunteer_id") || undefined;

  let payload: unknown;

  switch (role) {
    case "stage":
      payload = getStageState(db, sinceSeq);
      break;
    case "emcee":
      payload = getEmceeState(db);
      break;
    case "control":
      payload = getControlState(db);
      break;
    case "entry":
      payload = getVolunteerState(db, volunteerId);
      break;
    default: {
      const fullState = getEventState(db);
      const { control_pin: _c, entry_pin: _e, ...sanitizedEvent } = fullState;
      payload = {
        stage: getStageState(db, sinceSeq),
        event: sanitizedEvent,
        folded: foldLedger(db)
      };
      break;
    }
  }

  return new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    }
  });
}
