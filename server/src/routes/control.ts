import type { Database } from "bun:sqlite";
import {
  getEventState,
  updateEventState,
  getControlState,
  yankChyron,
  unyankChyron,
  foldLedger
} from "../ledger";

export async function handleControlRequest(req: Request, db: Database): Promise<Response> {
  if (req.method.toUpperCase() !== "POST") {
    return Response.json({ error: "METHOD_NOT_ALLOWED", message: "POST required" }, { status: 405 });
  }

  try {
    const body = await req.json() as Record<string, unknown>;
    const action = String(body.action || "");
    const currentState = getEventState(db);

    // Validate PIN if configured
    const providedPin = String(body.pin || req.headers.get("X-Control-Pin") || "");
    if (currentState.control_pin && providedPin !== currentState.control_pin && action !== "auth_check") {
      return Response.json({ error: "UNAUTHORIZED", message: "Invalid control PIN" }, { status: 401 });
    }

    if (action === "auth_check") {
      return Response.json({ ok: true, authenticated: true });
    }

    switch (action) {
      case "freeze":
        updateEventState(db, { is_frozen: 1 });
        break;

      case "unfreeze":
        updateEventState(db, { is_frozen: 0 });
        break;

      case "set_override": {
        const cents = typeof body.override_cents === "number" ? Math.round(body.override_cents) : null;
        updateEventState(db, { manual_override_cents: cents });
        break;
      }

      case "clear_override":
        updateEventState(db, { manual_override_cents: null });
        break;

      case "set_goal": {
        const goal = typeof body.goal_cents === "number" ? Math.round(body.goal_cents) : 50000000;
        updateEventState(db, { goal_cents: Math.max(100, goal) });
        break;
      }

      case "set_match": {
        const updates: Partial<Parameters<typeof updateEventState>[1]> = {};
        if (typeof body.is_active === "boolean") {
          updates.is_match_active = body.is_active ? 1 : 0;
        }
        if (typeof body.pool_cents === "number") {
          updates.match_pool_cents = Math.max(0, Math.round(body.pool_cents));
        }
        if (typeof body.total_cents === "number") {
          updates.match_total_cents = Math.max(0, Math.round(body.total_cents));
        }
        if (typeof body.ratio === "number") {
          updates.match_ratio = Math.max(0.1, body.ratio);
        }
        if (typeof body.sponsor_title === "string") {
          updates.match_sponsor_title = body.sponsor_title.trim();
        }
        updateEventState(db, updates);
        break;
      }

      case "yank_chyron": {
        const donationId = String(body.donation_id || "");
        const reason = typeof body.reason === "string" ? body.reason : "Yanked by AV technician";
        if (donationId) {
          yankChyron(db, donationId, "CONTROL_DECK", reason);
        }
        break;
      }

      case "unyank_chyron": {
        const donationId = String(body.donation_id || "");
        if (donationId) {
          unyankChyron(db, donationId);
        }
        break;
      }

      case "trigger_confetti": {
        updateEventState(db, { confetti_trigger: Date.now() });
        break;
      }

      case "resync_odometer": {
        // Resets the stage odometer floor to the exact current true folded total
        const folded = foldLedger(db);
        updateEventState(db, { odometer_floor_cents: folded.total_raised_cents });
        break;
      }

      case "set_qr_url": {
        const url = String(body.qr_donate_url || "").trim();
        if (url) {
          updateEventState(db, { qr_donate_url: url });
        }
        break;
      }

      case "set_event_name": {
        const name = String(body.event_name || "").trim();
        if (name) {
          updateEventState(db, { event_name: name });
        }
        break;
      }

      case "set_milestones": {
        if (Array.isArray(body.milestones)) {
          updateEventState(db, { milestones_json: JSON.stringify(body.milestones) });
        }
        break;
      }

      case "update_pins": {
        const updates: Partial<Parameters<typeof updateEventState>[1]> = {};
        if (typeof body.entry_pin === "string") {
          updates.entry_pin = body.entry_pin.trim();
        }
        if (typeof body.control_pin === "string") {
          updates.control_pin = body.control_pin.trim();
        }
        updateEventState(db, updates);
        break;
      }

      case "reset_ledger": {
        if (body.confirm_wipe !== true) {
          return Response.json({
            error: "CONFIRMATION_REQUIRED",
            message: "Must pass confirm_wipe: true to wipe all ledger data."
          }, { status: 400 });
        }

        db.transaction(() => {
          db.exec("DELETE FROM ledger;");
          db.exec("DELETE FROM yanked_chyrons;");
          db.exec("DELETE FROM connector_state;");
          updateEventState(db, {
            odometer_floor_cents: 0,
            manual_override_cents: null,
            is_frozen: 0,
            confetti_trigger: 0,
            match_pool_cents: 0,
            match_total_cents: 0,
            is_match_active: 0
          });
        })();
        break;
      }

      default:
        return Response.json({ error: "UNKNOWN_ACTION", message: `Unknown action: ${action}` }, { status: 400 });
    }

    const nextState = getControlState(db);
    return Response.json({ ok: true, state: nextState });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Control action failed";
    return Response.json({ error: "CONTROL_ERROR", message }, { status: 500 });
  }
}
