import type { Database } from "bun:sqlite";
import {
  getEventState,
  updateEventState,
  getControlState,
  holdDonation,
  releaseHeldDonation,
  foldLedger,
  startTimer,
  pauseTimer,
  resetTimer,
  addTimerSeconds,
  pinDonation,
  toggleDonationAnonymity,
  type EventStateRecord
} from "../ledger";

export async function handleControlRequest(req: Request, db: Database): Promise<Response> {
  if (req.method.toUpperCase() !== "POST" && req.method.toUpperCase() !== "PUT") {
    return Response.json({ error: "METHOD_NOT_ALLOWED", message: "POST or PUT required" }, { status: 405 });
  }

  try {
    const body = await req.json() as Record<string, unknown>;
    const action = String(body.action || (req.method.toUpperCase() === "PUT" ? "update_settings" : ""));
    const currentState = getEventState(db);

    const isAuthDisabled = process.env.GIVEBAR_DISABLE_AUTH === "1";
    const providedPin = String(body.pin || req.headers.get("X-Control-Pin") || "");
    const isControlPinValid = isAuthDisabled || (currentState.control_pin && currentState.control_pin.trim() !== "" && providedPin === currentState.control_pin);
    if (!isControlPinValid && action !== "auth_check") {
      return Response.json({ error: "UNAUTHORIZED", message: "Invalid or missing Control Room PIN" }, { status: 401 });
    }

    if (action === "auth_check") {
      return Response.json({ ok: isControlPinValid, authenticated: isControlPinValid });
    }

    switch (action) {
      case "update_settings": {
        const patch: Partial<EventStateRecord> = {};

        if (typeof body.event_name === "string" && body.event_name.trim()) {
          patch.event_name = body.event_name.trim();
        }
        if (typeof body.event_subtitle === "string") {
          patch.event_subtitle = body.event_subtitle.trim();
        }
        if (typeof body.goal_cents === "number" && body.goal_cents > 0) {
          patch.goal_cents = Math.round(body.goal_cents);
        }
        if (typeof body.qr_donate_url === "string") {
          patch.qr_donate_url = body.qr_donate_url.trim();
        }
        if (typeof body.theme_preset === "string") {
          patch.theme_preset = body.theme_preset.trim();
        }
        if (typeof body.brand_hue === "number") {
          patch.brand_hue = body.brand_hue;
        }
        if (typeof body.brand_chroma === "number") {
          patch.brand_chroma = body.brand_chroma;
        }
        if (typeof body.brand_accent_hex === "string") {
          patch.brand_accent_hex = body.brand_accent_hex.trim();
        }
        if (typeof body.brand_radius_px === "number") {
          patch.brand_radius_px = Math.round(body.brand_radius_px);
        }
        if (typeof body.major_gift_threshold_cents === "number") {
          patch.major_gift_threshold_cents = Math.round(body.major_gift_threshold_cents);
        }
        if (typeof body.stage_delay_ms === "number") {
          patch.stage_delay_ms = Math.max(0, Math.round(body.stage_delay_ms));
        }
        if (typeof body.confetti_on_milestone === "boolean" || typeof body.confetti_on_milestone === "number") {
          patch.confetti_on_milestone = body.confetti_on_milestone ? 1 : 0;
        }
        if (typeof body.thermometer_visual_mode === "string") {
          patch.thermometer_visual_mode = body.thermometer_visual_mode.trim();
        }
        if (typeof body.embed_media_url === "string") {
          patch.embed_media_url = body.embed_media_url.trim();
        }
        if (typeof body.trust_badge_text === "string") {
          patch.trust_badge_text = body.trust_badge_text.trim();
        }
        if (typeof body.countdown_seconds === "number") {
          patch.countdown_seconds = Math.max(0, Math.round(body.countdown_seconds));
        }
        // Matching Grant settings
        if (typeof body.is_match_active === "boolean" || typeof body.is_match_active === "number") {
          patch.is_match_active = body.is_match_active ? 1 : 0;
        }
        if (typeof body.match_total_cents === "number") {
          patch.match_total_cents = Math.max(0, Math.round(body.match_total_cents));
        }
        if (typeof body.match_ratio === "number") {
          patch.match_ratio = Math.max(0.1, body.match_ratio);
        }
        if (typeof body.match_sponsor_title === "string") {
          patch.match_sponsor_title = body.match_sponsor_title.trim();
        }

        db.transaction(() => {
          // Update ask tiers child table if provided
          if (Array.isArray(body.ask_tiers)) {
            db.exec(`DELETE FROM ask_tier;`);
            const insertTier = db.prepare(`INSERT INTO ask_tier (sort_order, cents, label) VALUES (?, ?, ?)`);
            body.ask_tiers.forEach((tier: unknown, idx: number) => {
              if (tier && typeof tier === "object" && "cents" in tier && typeof tier.cents === "number") {
                const label = "label" in tier && typeof tier.label === "string" ? tier.label : `$${Math.floor(tier.cents / 100).toLocaleString("en-US")}`;
                insertTier.run(idx + 1, Math.round(tier.cents), label);
              }
            });
          }

          // Update milestones child table if provided
          if (Array.isArray(body.milestones)) {
            db.exec(`DELETE FROM milestone;`);
            const insertMilestone = db.prepare(`INSERT INTO milestone (sort_order, percent_of_goal, cents, label, celebrate) VALUES (?, ?, ?, ?, ?)`);
            body.milestones.forEach((m: unknown, idx: number) => {
              if (m && typeof m === "object" && "label" in m && typeof m.label === "string") {
                const percent = "percent_of_goal" in m && typeof m.percent_of_goal === "number" ? m.percent_of_goal : null;
                const cents = "cents" in m && typeof m.cents === "number" ? Math.round(m.cents) : null;
                const celebrate = "celebrate" in m && !m.celebrate ? 0 : 1;
                insertMilestone.run(idx + 1, percent, cents, m.label, celebrate);
              }
            });
            patch.milestones_json = JSON.stringify(body.milestones);
          }

          updateEventState(db, patch);
        })();
        break;
      }

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
        const updates: Partial<EventStateRecord> = {};
        if (typeof body.is_active === "boolean") {
          updates.is_match_active = body.is_active ? 1 : 0;
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

      case "hold_donation":
      case "yank_chyron": {
        const donationId = String(body.donation_id || "");
        const reason = typeof body.reason === "string" ? body.reason : "Held by Event Director";
        if (donationId) {
          holdDonation(db, donationId, "CONTROL_ROOM", reason);
        }
        break;
      }

      case "release_donation":
      case "unyank_chyron": {
        const donationId = String(body.donation_id || "");
        if (donationId) {
          releaseHeldDonation(db, donationId);
        }
        break;
      }

      case "trigger_confetti": {
        updateEventState(db, { confetti_trigger: Date.now() });
        break;
      }

      case "resync_odometer": {
        const folded = foldLedger(db);
        updateEventState(db, { odometer_floor_cents: folded.total_raised_cents });
        break;
      }

      case "update_pins": {
        const updates: Partial<EventStateRecord> = {};
        if (typeof body.entry_pin === "string") {
          const ep = body.entry_pin.trim();
          if (ep && (ep.length < 4 || ep.length > 12)) {
            return Response.json({ error: "INVALID_PIN", message: "Entry PIN must be between 4 and 12 characters" }, { status: 400 });
          }
          updates.entry_pin = ep;
        }
        if (typeof body.control_pin === "string") {
          const cp = body.control_pin.trim();
          if (cp.length < 4 || cp.length > 12) {
            return Response.json({ error: "INVALID_PIN", message: "Control PIN must be between 4 and 12 characters" }, { status: 400 });
          }
          updates.control_pin = cp;
        }
        updateEventState(db, updates);
        break;
      }
      case "start_timer": {
        const sec = typeof body.seconds === "number" ? Math.round(body.seconds) : undefined;
        startTimer(db, sec);
        break;
      }

      case "pause_timer": {
        pauseTimer(db);
        break;
      }

      case "reset_timer": {
        const sec = typeof body.seconds === "number" ? Math.round(body.seconds) : undefined;
        resetTimer(db, sec);
        break;
      }

      case "add_timer_time": {
        const sec = typeof body.seconds === "number" ? Math.round(body.seconds) : 300;
        addTimerSeconds(db, sec);
        break;
      }

      case "pin_donation": {
        const donationId = String(body.donation_id || "");
        if (donationId) {
          pinDonation(db, donationId);
        }
        break;
      }

      case "toggle_anonymity": {
        const donationId = String(body.donation_id || "");
        if (donationId) {
          toggleDonationAnonymity(db, donationId);
        }
        break;
      }
      case "purge_rehearsal": {
        db.transaction(() => {
          db.exec("DELETE FROM ledger WHERE source = 'rehearsal';");
          db.exec("DELETE FROM active_card WHERE entered_by LIKE 'CLERK_%';");
          const folded = foldLedger(db);
          updateEventState(db, {
            odometer_floor_cents: folded.total_raised_cents
          });
        })();
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
          db.exec("DELETE FROM held_donations;");
          db.exec("DELETE FROM active_card;");
          db.exec("DELETE FROM connector_state;");
          updateEventState(db, {
            odometer_floor_cents: 0,
            manual_override_cents: null,
            is_frozen: 0,
            confetti_trigger: 0,
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
