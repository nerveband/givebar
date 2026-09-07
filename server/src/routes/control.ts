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
        if (typeof body.settings_seq === "number") {
          if (body.settings_seq !== currentState.settings_seq) {
            return Response.json({
              error: "SETTINGS_CONFLICT",
              message: "Settings have been modified in another session. Please reload before saving.",
              current_seq: currentState.settings_seq,
              expected_seq: body.settings_seq
            }, { status: 409 });
          }
        }
        if (typeof body.control_pin === "string") {
          const cp = body.control_pin.trim();
          if (cp.length < 4 || cp.length > 12) {
            return Response.json({ error: "INVALID_PIN", message: "Control PIN must be between 4 and 12 characters" }, { status: 400 });
          }
          patch.control_pin = cp;
        }
        if (typeof body.entry_pin === "string") {
          const ep = body.entry_pin.trim();
          if (ep.length < 4 || ep.length > 12) {
            return Response.json({ error: "INVALID_PIN", message: "Entry PIN must be between 4 and 12 characters" }, { status: 400 });
          }
          patch.entry_pin = ep;
        }

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
        if (typeof body.logo_url === "string") {
          patch.logo_url = body.logo_url.trim();
        }
        if (typeof body.background_style === "string") {
          const bs = body.background_style.trim().toLowerCase();
          patch.background_style = (bs === "subtle-gradient" || bs === "vignette") ? bs : "plain";
        }
        if (typeof body.bar_color === "string") {
          patch.bar_color = body.bar_color.trim();
        }
        if (typeof body.show_qr === "boolean" || typeof body.show_qr === "number") {
          patch.show_qr = body.show_qr ? 1 : 0;
        }
        if (typeof body.show_recent_donations === "boolean" || typeof body.show_recent_donations === "number") {
          patch.show_recent_donations = body.show_recent_donations ? 1 : 0;
        }
        if (typeof body.show_live_indicator === "boolean" || typeof body.show_live_indicator === "number") {
          patch.show_live_indicator = body.show_live_indicator ? 1 : 0;
        }
        if (typeof body.show_goal === "boolean" || typeof body.show_goal === "number") {
          patch.show_goal = body.show_goal ? 1 : 0;
        }
        if (typeof body.stage_message === "string") {
          patch.stage_message = body.stage_message.trim();
        }
        if (typeof body.stage_message_visible === "boolean" || typeof body.stage_message_visible === "number") {
          patch.stage_message_visible = body.stage_message_visible ? 1 : 0;
        }
        if (typeof body.feature_timer === "boolean" || typeof body.feature_timer === "number") {
          patch.feature_timer = body.feature_timer ? 1 : 0;
        }
        if (typeof body.feature_card_number === "boolean" || typeof body.feature_card_number === "number") {
          patch.feature_card_number = body.feature_card_number ? 1 : 0;
        }
        if (typeof body.feature_table_number === "boolean" || typeof body.feature_table_number === "number") {
          patch.feature_table_number = body.feature_table_number ? 1 : 0;
        }
        if (typeof body.bloomerang_api_key === "string") {
          const key = body.bloomerang_api_key.trim();
          if (!key.startsWith("•••") && !key.startsWith("...")) {
            patch.bloomerang_api_key = key;
          }
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

      case "update_pins": {
        const updates: Partial<EventStateRecord> = {};
        if (typeof body.entry_pin === "string") {
          const ep = body.entry_pin.trim();
          if (ep.length < 4 || ep.length > 12) {
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
          db.exec("DELETE FROM active_card WHERE entered_by LIKE 'CLERK_%' OR entered_by LIKE 'User_%' OR entered_by = 'REHEARSAL_BOT';");
          const folded = foldLedger(db);
          updateEventState(db, {
            odometer_floor_cents: folded.total_raised_cents
          });
        })();
        break;
      }
      case "test_bloomerang": {
        const state = getEventState(db);
        const candidateKey = typeof body.api_key === "string" && !body.api_key.startsWith("•••") && body.api_key.trim() !== ""
          ? body.api_key.trim()
          : state.bloomerang_api_key;
        if (!candidateKey) {
          updateEventState(db, { bloomerang_last_error: "API key is required" });
          return Response.json({ ok: false, error: "API key is required" }, { status: 400 });
        }
        const now = Date.now();
        updateEventState(db, {
          bloomerang_api_key: candidateKey,
          bloomerang_last_sync_at: now,
          bloomerang_last_error: ""
        });
        const nextState = getControlState(db);
        return Response.json({ ok: true, connected: true, last_sync_at: now, state: nextState });
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
            is_frozen: 0,
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
