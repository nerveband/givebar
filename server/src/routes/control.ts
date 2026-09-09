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
import { changePin, createInvite, getSession, login, logout, normalizeUsername, redeemInvite, requireRole } from "../authz";
import {
  FONT_FAMILY_KEYS,
  isChartOrientation,
  isFontFamilyKey,
  isValidColor,
  isValidQrUrl
} from "../settings";

export async function handleControlRequest(req: Request, db: Database): Promise<Response> {
  if (req.method.toUpperCase() !== "POST" && req.method.toUpperCase() !== "PUT") {
    return Response.json({ error: "METHOD_NOT_ALLOWED", message: "POST or PUT required" }, { status: 405 });
  }
  try {
    const body = await req.json() as Record<string, unknown>;
    const action = String(body.action || (req.method.toUpperCase() === "PUT" ? "update_settings" : ""));
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    if (action === "login") {
      return (await login(db, String(body.username || ""), String(body.pin || ""), ip)).response;
    }
    if (action === "logout") return logout(req, db);
    if (action === "auth_check") {
      const session = getSession(req, db);
      return Response.json({ ok: Boolean(session), authenticated: Boolean(session), username: session?.username || null, role: session?.role || null });
    }
    if (action === "redeem_invite") return redeemInvite(db, String(body.token || ""));
    if (action === "change_pin") return changePin(db, req, String(body.current_pin || ""), String(body.pin || body.next_pin || ""));
    if (action === "bootstrap_admin") {
      const existing = db.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM operator_account WHERE disabled = 0`).get()?.count || 0;
      if (existing !== 0) return Response.json({ error: "FORBIDDEN", message: "An administrator already exists." }, { status: 403 });
      const username = normalizeUsername(body.username);
      const displayName = String(body.displayName || body.display_name || "").trim().slice(0, 80);
      const pin = String(body.pin || "");
      if (!username || !displayName || pin.length < 4 || pin.length > 12) {
        return Response.json({ error: "INVALID_ACCOUNT", message: "Name, display name, and a 4-12 character PIN are required." }, { status: 400 });
      }
      const id = crypto.randomUUID();
      db.query(`INSERT INTO operator_account (id, username, display_name, pin_hash, role, created_at) VALUES (?, ?, ?, ?, 'admin', ?)`)
        .run(id, username, displayName, await Bun.password.hash(pin), Date.now());
      db.query(`INSERT INTO access_audit (actor_id, action, created_at) VALUES (?, 'bootstrap_admin', ?)`).run(id, Date.now());
      return Response.json({ ok: true, id });
    }
    if (action === "create_account") {
      const admin = requireRole(db, req, ["admin"]);
      if (admin instanceof Response) return admin;
      const username = normalizeUsername(body.username);
      const displayName = String(body.displayName || body.display_name || "").trim().slice(0, 80);
      const pin = String(body.pin || "");
      const role = String(body.role || "operator");
      if (!username || !displayName || pin.length < 4 || pin.length > 12 || !["admin", "operator"].includes(role)) {
        return Response.json({ error: "INVALID_ACCOUNT", message: "Name, display name, 4-12 character PIN, and admin/operator role are required." }, { status: 400 });
      }
      const id = crypto.randomUUID();
      try {
        db.query(`INSERT INTO operator_account (id, username, display_name, pin_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(id, username, displayName, await Bun.password.hash(pin), role, Date.now());
      } catch {
        return Response.json({ error: "ACCOUNT_EXISTS", message: "That operator name already exists." }, { status: 409 });
      }
      db.query(`INSERT INTO access_audit (actor_id, action, target_id, created_at) VALUES (?, 'create_account', ?, ?)`).run(admin.accountId, id, Date.now());
      return Response.json({ ok: true, id });
    }
    if (action === "send_invite") {
      const admin = requireRole(db, req, ["admin"]);
      if (admin instanceof Response) return admin;
      const id = String(body.id || "");
      const row = db.query<{ id: string }, [string]>(`SELECT id FROM operator_account WHERE id = ?`).get(id);
      if (!row) return Response.json({ error: "NOT_FOUND", message: "Operator not found." }, { status: 404 });
      try {
        const { link } = await createInvite(db, req, id, String(body.email || ""));
        db.query(`INSERT INTO access_audit (actor_id, action, target_id, created_at) VALUES (?, 'send_invite', ?, ?)`).run(admin.accountId, id, Date.now());
        return Response.json({ ok: true, link });
      } catch (error) {
        return Response.json({ error: "INVITE_FAILED", message: error instanceof Error ? error.message : "Could not send invite." }, { status: 400 });
      }
    }
    if (action === "update_account") {
      const admin = requireRole(db, req, ["admin"]);
      if (admin instanceof Response) return admin;
      const id = String(body.id || "");
      const row = db.query<{ id: string }, [string]>(`SELECT id FROM operator_account WHERE id = ?`).get(id);
      if (!row) return Response.json({ error: "NOT_FOUND", message: "Operator not found." }, { status: 404 });
      const displayName = body.displayName !== undefined || body.display_name !== undefined ? String(body.displayName || body.display_name || "").trim().slice(0, 80) : undefined;
      const role = body.role !== undefined ? String(body.role) : undefined;
      const pin = body.pin !== undefined ? String(body.pin) : undefined;
      const disabled = body.disabled !== undefined ? Boolean(body.disabled) : undefined;
      if (displayName !== undefined && !displayName) return Response.json({ error: "INVALID_ACCOUNT", message: "Display name cannot be empty." }, { status: 400 });
      if (role !== undefined && !["admin", "operator"].includes(role)) return Response.json({ error: "INVALID_ACCOUNT", message: "Role must be admin or operator." }, { status: 400 });
      if (pin !== undefined && pin !== "" && (pin.length < 4 || pin.length > 12)) return Response.json({ error: "INVALID_PIN", message: "PIN must be 4-12 characters." }, { status: 400 });
      if (disabled !== undefined && id === admin.accountId && disabled) return Response.json({ error: "INVALID_ACCOUNT", message: "You cannot disable your own administrator account." }, { status: 400 });
      if (displayName !== undefined) db.query(`UPDATE operator_account SET display_name = ? WHERE id = ?`).run(displayName, id);
      if (role !== undefined) db.query(`UPDATE operator_account SET role = ? WHERE id = ?`).run(role, id);
      if (pin) db.query(`UPDATE operator_account SET pin_hash = ? WHERE id = ?`).run(await Bun.password.hash(pin), id);
      if (disabled !== undefined) db.query(`UPDATE operator_account SET disabled = ? WHERE id = ?`).run(disabled ? 1 : 0, id);
      db.query(`INSERT INTO access_audit (actor_id, action, target_id, created_at) VALUES (?, 'update_account', ?, ?)`).run(admin.accountId, id, Date.now());
      return Response.json({ ok: true });
    }
    if (action === "list_accounts") {
      const admin = requireRole(db, req, ["admin"]);
      if (admin instanceof Response) return admin;
      const accounts = db.query<{ id: string; username: string; display_name: string; role: string; disabled: number }, []>(
        `SELECT id, username, display_name, role, disabled FROM operator_account ORDER BY username`
      ).all();
      return Response.json({ ok: true, accounts: accounts.map((account) => ({ ...account, disabled: Boolean(account.disabled) })) });
    }
    if (action === "list_audit") {
      const admin = requireRole(db, req, ["admin"]);
      if (admin instanceof Response) return admin;
      const rows = db.query<{ actor: string | null; action: string; target: string | null; created_at: number }, []>(
        `SELECT a.username AS actor, l.action, l.target_id AS target, l.created_at
         FROM access_audit l LEFT JOIN operator_account a ON a.id = l.actor_id
         ORDER BY l.id DESC LIMIT 100`
      ).all();
      return Response.json({ ok: true, audit: rows });
    }
    const operator = requireRole(db, req, ["admin", "operator"]);
    if (operator instanceof Response) return operator;
    const currentState = getEventState(db);

    switch (action) {
      case "update_settings": {
        // Removed keys fail loudly: a stale client binding must not look like a successful save.
        for (const removed of ["qr_donate_url", "milestones_json"]) {
          if (removed in body) {
            return Response.json({
              error: "INVALID_SETTING",
              message: removed === "qr_donate_url"
                ? "qr_donate_url was removed. Send qr_url (the URL encoded into the QR) and display_url (the short text printed under it)."
                : "milestones_json was removed. Send the milestones array; the milestone table is authoritative."
            }, { status: 400 });
          }
        }
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
        if (body.control_pin !== undefined || body.entry_pin !== undefined) {
          return Response.json({ error: "REMOVED_AUTH", message: "Shared PINs are retired. Create a named operator account instead." }, { status: 410 });
        }

        if (typeof body.event_name === "string" && body.event_name.trim()) {
          patch.event_name = body.event_name.trim();
        }
        if (typeof body.event_subtitle === "string") {
          patch.event_subtitle = body.event_subtitle.trim();
        }
        if (typeof body.event_title === "string") {
          patch.event_title = body.event_title.trim();
        }
        if (body.goal_cents !== undefined) {
          const goal = typeof body.goal_cents === "number" ? body.goal_cents : NaN;
          if (!Number.isFinite(goal) || goal <= 0 || Math.round(goal) !== goal) {
            return Response.json({ error: "INVALID_SETTING", message: "goal_cents must be a positive integer number of cents" }, { status: 400 });
          }
          patch.goal_cents = goal;
        }
        if (typeof body.qr_url === "string") {
          const qrUrl = body.qr_url.trim();
          if (!isValidQrUrl(qrUrl)) {
            return Response.json({ error: "INVALID_SETTING", message: "qr_url must be an absolute http(s) URL or empty" }, { status: 400 });
          }
          patch.qr_url = qrUrl;
        }
        if (typeof body.display_url === "string") {
          patch.display_url = body.display_url.trim().slice(0, 200);
        }
        if (typeof body.font_family === "string") {
          const font = body.font_family.trim();
          if (!isFontFamilyKey(font)) {
            return Response.json({
              error: "INVALID_SETTING",
              message: `font_family must be one of: ${FONT_FAMILY_KEYS.join(", ")}`
            }, { status: 400 });
          }
          patch.font_family = font;
        }
        if (typeof body.chart_orientation === "string") {
          const orientation = body.chart_orientation.trim().toLowerCase();
          if (!isChartOrientation(orientation)) {
            return Response.json({
              error: "INVALID_SETTING",
              message: "chart_orientation must be 'horizontal' or 'vertical'"
            }, { status: 400 });
          }
          patch.chart_orientation = orientation;
        }
        if (body.marker_mode !== undefined) {
          if (!["milestones", "dollars", "none"].includes(String(body.marker_mode))) {
            return Response.json({ error: "INVALID_SETTING", message: "Choose milestones, dollars, or no chart markers." }, { status: 400 });
          }
          patch.marker_mode = String(body.marker_mode);
        }
        if (body.marker_step_cents !== undefined) {
          if (typeof body.marker_step_cents !== "number" || !Number.isSafeInteger(body.marker_step_cents) || body.marker_step_cents < 100) {
            return Response.json({ error: "INVALID_SETTING", message: "Marker spacing must be at least $1 in whole cents." }, { status: 400 });
          }
          patch.marker_step_cents = body.marker_step_cents;
        }
        if (typeof body.background_image_url === "string") {
          patch.background_image_url = body.background_image_url.trim();
        }
        if (body.qr_image_url !== undefined) {
          const image = typeof body.qr_image_url === "string" ? body.qr_image_url.trim() : null;
          if (image === null || image.length > 2800000 || (image !== "" && !/^(?:https:\/\/[^\s]+|\/(?!\/)[^\s]+|data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2})$/i.test(image))) {
            return Response.json({ error: "INVALID_SETTING", message: "Choose a PNG, JPEG, WebP, or SVG image up to 2 MB, an HTTPS image URL, or a local asset path." }, { status: 400 });
          }
          patch.qr_image_url = image;
        }
        if (body.qr_image_backdrop !== undefined) {
          if (typeof body.qr_image_backdrop !== "boolean") {
            return Response.json({ error: "INVALID_SETTING", message: "QR backdrop must be on or off." }, { status: 400 });
          }
          patch.qr_image_backdrop = body.qr_image_backdrop ? 1 : 0;
        }
        for (const key of ["gradient_start", "gradient_end"] as const) {
          if (body[key] !== undefined) {
            if (typeof body[key] !== "string" || !/^#[0-9a-f]{6}$/i.test(body[key])) {
              return Response.json({ error: "INVALID_SETTING", message: `${key} must be a six-digit hex color.` }, { status: 400 });
            }
            patch[key] = body[key];
          }
        }
        for (const [key, max] of [["gradient_angle", 360], ["gradient_intensity", 100]] as const) {
          if (body[key] !== undefined) {
            if (typeof body[key] !== "number" || !Number.isInteger(body[key]) || body[key] < 0 || body[key] > max) {
              return Response.json({ error: "INVALID_SETTING", message: `${key} must be between 0 and ${max}.` }, { status: 400 });
            }
            patch[key] = body[key];
          }
        }
        if (typeof body.background_video_url === "string") {
          const video = body.background_video_url.trim();
          if (video && !/^(https?:\/\/|\/(?!\/))/i.test(video)) {
            return Response.json({ error: "INVALID_SETTING", message: "Use an HTTPS video URL or a local asset path." }, { status: 400 });
          }
          patch.background_video_url = video;
        }
        if (body.impact_messages !== undefined) {
          if (!Array.isArray(body.impact_messages) || body.impact_messages.length > 12 || body.impact_messages.some((text: unknown) => typeof text !== "string" || text.trim().length > 160)) {
            return Response.json({ error: "INVALID_SETTING", message: "Use up to 12 impact messages, each no longer than 160 characters." }, { status: 400 });
          }
          patch.impact_messages = JSON.stringify(body.impact_messages.map((text: string) => text.trim()).filter(Boolean));
        }
        if (typeof body.text_color === "string") {
          const textColor = body.text_color.trim();
          if (!isValidColor(textColor)) {
            return Response.json({ error: "INVALID_SETTING", message: "text_color must be a hex or oklch() color, or empty" }, { status: 400 });
          }
          patch.text_color = textColor;
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
          const barColor = body.bar_color.trim();
          if (!isValidColor(barColor)) {
            return Response.json({ error: "INVALID_SETTING", message: "bar_color must be a hex or oklch() color, or empty" }, { status: 400 });
          }
          patch.bar_color = barColor;
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
          const sampleIds = db.query<{ donation_id: string }, []>(
            "SELECT DISTINCT donation_id FROM ledger WHERE source = 'rehearsal' AND event_type = 'create'"
          ).all();
          for (const { donation_id } of sampleIds) {
            db.query("DELETE FROM active_card WHERE donation_id = ?").run(donation_id);
            db.query("DELETE FROM held_donations WHERE donation_id = ?").run(donation_id);
            db.query("DELETE FROM ledger WHERE donation_id = ? OR donation_id = ?").run(donation_id, `match_${donation_id}`);
          }
          const folded = foldLedger(db);
          updateEventState(db, {
            odometer_floor_cents: folded.total_raised_cents,
            stage_reset_seq: currentState.stage_reset_seq + 1,
            pinned_donation_id: null
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
        try {
          const response = await fetch("https://api.bloomerang.co/v2/database", {
            headers: { "X-API-KEY": candidateKey, Accept: "application/json" },
            signal: AbortSignal.timeout(10000), redirect: "error"
          });
          if (!response.ok) {
            const message = `Bloomerang rejected the connection (HTTP ${response.status}). Check the CRM private API key.`;
            updateEventState(db, { bloomerang_last_error: message });
            return Response.json({ ok: false, connected: false, error: message }, { status: 502 });
          }
          const organization = await response.json() as { Id?: string; Name?: string };
          if (!organization.Id || !organization.Name) throw new Error("Unexpected organization response");
          updateEventState(db, { bloomerang_api_key: candidateKey, bloomerang_last_error: "" });
          return Response.json({ ok: true, connected: true, organization: organization.Name,
            last_sync_at: state.bloomerang_last_sync_at, state: getControlState(db) });
        } catch {
          const message = "Could not verify the Bloomerang connection. No donations were imported.";
          updateEventState(db, { bloomerang_last_error: message });
          return Response.json({ ok: false, connected: false, error: message }, { status: 502 });
        }
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
            stage_reset_seq: currentState.stage_reset_seq + 1,
            pinned_donation_id: null,
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
