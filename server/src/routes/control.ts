import type { Database } from "bun:sqlite";
import { getEventState, updateEventState, getControlState, getStageState, foldLedger, type EventStateRecord } from "../ledger";
import { changePin, createInvite, createInviteLink, getSession, login, logout, normalizeUsername, OPERATOR_STEPS, redeemInvite, requireRole, type OperatorSession } from "../authz";
import { FONT_FAMILY_KEYS, isChartOrientation, isFontFamilyKey, isValidColor, isValidQrUrl } from "../settings";
import type { BackupManager } from "../backup";

type Body = Record<string, unknown>;

function invalid(message: string): Response {
  return Response.json({ error: "INVALID_SETTING", message }, { status: 400 });
}

function audit(db: Database, actorId: string | null, action: string, targetId: string | null = null): void {
  db.query(`INSERT INTO access_audit (actor_id, action, target_id, created_at) VALUES (?, ?, ?, ?)`).run(actorId, action, targetId, Date.now());
}

/** Validates a settings patch. Returns the patch or the 400 response explaining the first problem. */
function settingsPatch(body: Body, current: EventStateRecord): Partial<EventStateRecord> | Response {
  if (typeof body.settings_seq === "number" && body.settings_seq !== current.settings_seq) {
    return Response.json({
      error: "SETTINGS_CONFLICT",
      message: "Settings were changed in another session. Reload before saving.",
      current_seq: current.settings_seq,
      expected_seq: body.settings_seq
    }, { status: 409 });
  }
  const patch: Partial<EventStateRecord> = {};
  const text = (key: keyof EventStateRecord, max = 500) => {
    if (typeof body[key] === "string") (patch as Record<string, unknown>)[key] = (body[key] as string).trim().slice(0, max);
  };
  const flag = (key: keyof EventStateRecord) => {
    if (typeof body[key] === "boolean" || typeof body[key] === "number") (patch as Record<string, unknown>)[key] = body[key] ? 1 : 0;
  };

  if (typeof body.event_name === "string" && body.event_name.trim()) patch.event_name = body.event_name.trim().slice(0, 200);
  text("event_subtitle", 200);
  text("event_title", 200);
  text("display_url", 200);
  text("theme_preset", 40);
  text("brand_accent_hex", 40);
  text("trust_badge_text", 200);
  text("logo_url", 2800000);
  text("background_image_url", 2800000);
  text("match_sponsor_title", 200);
  text("stage_message", 160);
  flag("is_match_active");
  flag("show_qr");
  flag("show_recent_donations");
  flag("show_live_indicator");
  flag("show_goal");
  flag("stage_message_visible");
  flag("feature_card_number");
  flag("feature_table_number");

  if (body.goal_cents !== undefined) {
    if (typeof body.goal_cents !== "number" || !Number.isSafeInteger(body.goal_cents) || body.goal_cents <= 0) return invalid("goal_cents must be a positive whole number of cents");
    patch.goal_cents = body.goal_cents;
  }
  if (typeof body.qr_url === "string") {
    if (!isValidQrUrl(body.qr_url.trim())) return invalid("qr_url must be an absolute http(s) URL or empty");
    patch.qr_url = body.qr_url.trim();
  }
  if (typeof body.font_family === "string") {
    if (!isFontFamilyKey(body.font_family.trim())) return invalid(`font_family must be one of: ${FONT_FAMILY_KEYS.join(", ")}`);
    patch.font_family = body.font_family.trim();
  }
  if (typeof body.chart_orientation === "string") {
    const orientation = body.chart_orientation.trim().toLowerCase();
    if (!isChartOrientation(orientation)) return invalid("chart_orientation must be 'horizontal' or 'vertical'");
    patch.chart_orientation = orientation;
  }
  if (body.marker_mode !== undefined) {
    if (!["milestones", "dollars", "none"].includes(String(body.marker_mode))) return invalid("Choose milestones, dollars, or no chart markers.");
    patch.marker_mode = String(body.marker_mode);
  }
  if (body.marker_step_cents !== undefined) {
    if (typeof body.marker_step_cents !== "number" || !Number.isSafeInteger(body.marker_step_cents) || body.marker_step_cents < 100) return invalid("Marker spacing must be at least $1 in whole cents.");
    patch.marker_step_cents = body.marker_step_cents;
  }
  if (body.qr_image_url !== undefined) {
    const image = typeof body.qr_image_url === "string" ? body.qr_image_url.trim() : null;
    if (image === null || image.length > 2800000 || (image !== "" && !/^(?:https:\/\/[^\s]+|\/(?!\/)[^\s]+|data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2})$/i.test(image))) {
      return invalid("Choose a PNG, JPEG, WebP, or SVG image up to 2 MB, an HTTPS image URL, or a local asset path.");
    }
    patch.qr_image_url = image;
  }
  if (body.qr_image_backdrop !== undefined) {
    if (typeof body.qr_image_backdrop !== "boolean") return invalid("QR backdrop must be on or off.");
    patch.qr_image_backdrop = body.qr_image_backdrop ? 1 : 0;
  }
  for (const key of ["gradient_start", "gradient_end"] as const) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "string" || !/^#[0-9a-f]{6}$/i.test(body[key] as string)) return invalid(`${key} must be a six-digit hex color.`);
      patch[key] = body[key] as string;
    }
  }
  for (const [key, max] of [["gradient_angle", 360], ["gradient_intensity", 100]] as const) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "number" || !Number.isInteger(body[key]) || (body[key] as number) < 0 || (body[key] as number) > max) return invalid(`${key} must be between 0 and ${max}.`);
      patch[key] = body[key] as number;
    }
  }
  if (typeof body.background_video_url === "string") {
    const video = body.background_video_url.trim();
    if (video && !/^(https?:\/\/|\/(?!\/))/i.test(video)) return invalid("Use an HTTPS video URL or a local asset path.");
    patch.background_video_url = video;
  }
  if (body.impact_messages !== undefined) {
    if (!Array.isArray(body.impact_messages) || body.impact_messages.length > 12 || body.impact_messages.some(item => typeof item !== "string" || item.trim().length > 160)) {
      return invalid("Use up to 12 impact messages, each no longer than 160 characters.");
    }
    patch.impact_messages = JSON.stringify((body.impact_messages as string[]).map(item => item.trim()).filter(Boolean));
  }
  for (const key of ["text_color", "bar_color"] as const) {
    if (typeof body[key] === "string") {
      if (!isValidColor((body[key] as string).trim())) return invalid(`${key} must be a hex or oklch() color, or empty`);
      patch[key] = (body[key] as string).trim();
    }
  }
  if (typeof body.background_style === "string") {
    const style = body.background_style.trim().toLowerCase();
    patch.background_style = style === "subtle-gradient" || style === "vignette" ? style : "plain";
  }
  if (typeof body.brand_hue === "number") patch.brand_hue = body.brand_hue;
  if (typeof body.brand_chroma === "number") patch.brand_chroma = body.brand_chroma;
  if (typeof body.brand_radius_px === "number") patch.brand_radius_px = Math.round(body.brand_radius_px);
  if (typeof body.major_gift_threshold_cents === "number") patch.major_gift_threshold_cents = Math.max(100, Math.round(body.major_gift_threshold_cents));
  if (typeof body.stage_delay_ms === "number") patch.stage_delay_ms = Math.min(120000, Math.max(0, Math.round(body.stage_delay_ms)));
  if (typeof body.match_total_cents === "number") patch.match_total_cents = Math.max(0, Math.round(body.match_total_cents));
  if (typeof body.match_ratio === "number") patch.match_ratio = Math.max(0.1, body.match_ratio);
  return patch;
}

function replaceChildRows(db: Database, body: Body): void {
  if (Array.isArray(body.ask_tiers)) {
    db.exec(`DELETE FROM ask_tier;`);
    const insert = db.prepare(`INSERT INTO ask_tier (sort_order, cents, label) VALUES (?, ?, ?)`);
    (body.ask_tiers as unknown[]).forEach((tier, index) => {
      if (tier && typeof tier === "object" && typeof (tier as Body).cents === "number") {
        const cents = Math.round((tier as Body).cents as number);
        const label = typeof (tier as Body).label === "string" && ((tier as Body).label as string).trim() ? ((tier as Body).label as string).trim() : `$${Math.floor(cents / 100).toLocaleString("en-US")}`;
        insert.run(index + 1, cents, label);
      }
    });
  }
  if (Array.isArray(body.milestones)) {
    db.exec(`DELETE FROM milestone;`);
    const insert = db.prepare(`INSERT INTO milestone (sort_order, percent_of_goal, cents, label, celebrate) VALUES (?, ?, ?, ?, ?)`);
    (body.milestones as unknown[]).forEach((row, index) => {
      if (row && typeof row === "object" && typeof (row as Body).label === "string") {
        const percent = typeof (row as Body).percent_of_goal === "number" ? (row as Body).percent_of_goal as number : null;
        const cents = typeof (row as Body).cents === "number" ? Math.round((row as Body).cents as number) : null;
        insert.run(index + 1, percent, cents, (row as Body).label as string, "celebrate" in (row as Body) && !(row as Body).celebrate ? 0 : 1);
      }
    });
  }
}

/** Everything a team lead needs to hand to the room: links, steps, and the accounts that exist. */
function briefing(db: Database, req: Request) {
  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim();
  const origin = `${forwardedProto || new URL(req.url).protocol.replace(":", "")}://${req.headers.get("x-forwarded-host") || req.headers.get("host") || new URL(req.url).host}`;
  const state = getEventState(db);
  return {
    event_name: state.event_name,
    stage_delay_seconds: Math.round(state.stage_delay_ms / 1000),
    major_gift_threshold_cents: state.major_gift_threshold_cents,
    links: {
      signin: `${origin}/signin`,
      donations: `${origin}/donations`,
      chart: `${origin}/projector`,
      presenter: `${origin}/presenter`,
      home: `${origin}/`
    },
    steps: OPERATOR_STEPS.map(step => step.replace("the staging delay", `${Math.round(state.stage_delay_ms / 1000)} seconds`)),
    operators: db.query<{ username: string; display_name: string; role: string }, []>(`SELECT username, display_name, role FROM operator_account WHERE disabled = 0 ORDER BY role, username`).all()
  };
}

export async function handleControlRequest(req: Request, db: Database, backups: BackupManager): Promise<Response> {
  if (req.method !== "POST") return Response.json({ error: "METHOD_NOT_ALLOWED", message: "POST required" }, { status: 405 });
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "INVALID_JSON", message: "Body must be JSON" }, { status: 400 });
  }
  const action = String(body.action || "");
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  // Session lifecycle: no operator session required.
  if (action === "login") return (await login(db, req, String(body.username || ""), String(body.pin || ""), ip)).response;
  if (action === "logout") return logout(req, db);
  if (action === "auth_check") {
    const session = getSession(req, db);
    const accounts = db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM operator_account WHERE disabled = 0`).get()!.count;
    return Response.json({ authenticated: Boolean(session), username: session?.username || null, displayName: session?.displayName || null, role: session?.role || null, has_operator_accounts: accounts > 0 }, { headers: { "Cache-Control": "no-store" } });
  }
  if (action === "redeem_invite") return redeemInvite(db, req, String(body.token || ""));
  if (action === "change_pin") return changePin(db, req, String(body.current_pin || ""), String(body.pin || ""));
  if (action === "bootstrap_admin") {
    const existing = db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM operator_account WHERE disabled = 0`).get()!.count;
    if (existing !== 0) return Response.json({ error: "FORBIDDEN", message: "An administrator already exists." }, { status: 403 });
    const username = normalizeUsername(body.username);
    const displayName = String(body.displayName || "").trim().slice(0, 80);
    const pin = String(body.pin || "");
    if (!username || !displayName || pin.length < 4 || pin.length > 12) return Response.json({ error: "INVALID_ACCOUNT", message: "Name, display name, and a 4-12 character PIN are required." }, { status: 400 });
    const id = crypto.randomUUID();
    db.query(`INSERT INTO operator_account (id, username, display_name, pin_hash, role, created_at) VALUES (?, ?, ?, ?, 'admin', ?)`).run(id, username, displayName, await Bun.password.hash(pin), Date.now());
    audit(db, id, "bootstrap_admin");
    return Response.json({ ok: true, id });
  }

  const auth = requireRole(db, req, ["admin", "operator"]);
  if (auth instanceof Response) return auth;
  const operator: OperatorSession = auth;
  const adminOnly = (): Response | null => operator.role === "admin" ? null : Response.json({ error: "FORBIDDEN", message: "Administrator access required." }, { status: 403 });

  try {
    switch (action) {
      // Operator actions --------------------------------------------------
      case "briefing":
        return Response.json(briefing(db, req));
      case "stage_message": {
        const patch = settingsPatch({ stage_message: body.stage_message, stage_message_visible: body.stage_message_visible, impact_messages: body.impact_messages }, getEventState(db));
        if (patch instanceof Response) return patch;
        updateEventState(db, patch);
        break;
      }
      case "pause_chart":
        // Settle the ratchet first so the frozen figure is what the room sees right now.
        getStageState(db);
        updateEventState(db, { is_frozen: 1 });
        audit(db, operator.accountId, "pause_chart");
        break;
      case "resume_chart":
        updateEventState(db, { is_frozen: 0 });
        audit(db, operator.accountId, "resume_chart");
        break;
      case "add_team_note": {
        const note = String(body.body || "").trim().slice(0, 1000);
        if (!note) return Response.json({ error: "INVALID_NOTE", message: "Write something before posting." }, { status: 400 });
        db.query(`INSERT INTO team_note (author_id, author_name, body, created_at) VALUES (?, ?, ?, ?)`).run(operator.accountId, operator.displayName, note, Date.now());
        db.query(`UPDATE event_state SET updated_at = ? WHERE id = 1`).run(Date.now());
        break;
      }
      case "delete_team_note": {
        const id = Number(body.id);
        const row = db.query<{ author_id: string }, [number]>(`SELECT author_id FROM team_note WHERE id = ?`).get(id);
        if (!row) return Response.json({ error: "NOT_FOUND", message: "Note not found." }, { status: 404 });
        if (row.author_id !== operator.accountId && operator.role !== "admin") return Response.json({ error: "FORBIDDEN", message: "Only the author or an administrator can remove a note." }, { status: 403 });
        db.query(`DELETE FROM team_note WHERE id = ?`).run(id);
        db.query(`UPDATE event_state SET updated_at = ? WHERE id = 1`).run(Date.now());
        break;
      }

      // Administrator actions ---------------------------------------------
      case "update_settings": {
        const denied = adminOnly();
        if (denied) return denied;
        const patch = settingsPatch(body, getEventState(db));
        if (patch instanceof Response) return patch;
        db.transaction(() => {
          replaceChildRows(db, body);
          updateEventState(db, patch);
        })();
        audit(db, operator.accountId, "update_settings");
        break;
      }
      case "resync_chart": {
        // Before doors, after deleting test entries: put the wall figure back on the real total.
        const denied = adminOnly();
        if (denied) return denied;
        const current = getEventState(db);
        updateEventState(db, { odometer_floor_cents: 0, stage_reset_seq: current.stage_reset_seq + 1, is_frozen: 0 });
        getStageState(db);
        audit(db, operator.accountId, "resync_chart");
        break;
      }
      case "purge_rehearsal": {
        const denied = adminOnly();
        if (denied) return denied;
        backups.snapshot("pre-purge");
        db.transaction(() => {
          const sampleIds = db.query<{ donation_id: string }, []>(`SELECT DISTINCT donation_id FROM ledger WHERE source = 'rehearsal' AND event_type = 'create'`).all();
          for (const { donation_id } of sampleIds) {
            db.query(`DELETE FROM active_card WHERE donation_id = ?`).run(donation_id);
            db.query(`DELETE FROM held_donations WHERE donation_id = ?`).run(donation_id);
            db.query(`DELETE FROM ledger WHERE donation_id = ? OR donation_id = ?`).run(donation_id, `match_${donation_id}`);
          }
          const current = getEventState(db);
          updateEventState(db, { odometer_floor_cents: 0, stage_reset_seq: current.stage_reset_seq + 1 });
        })();
        // The wall restarts from the staged view: held gifts and gifts inside the staging window stay off it.
        getStageState(db);
        audit(db, operator.accountId, "purge_rehearsal");
        break;
      }
      case "reset_ledger": {
        const denied = adminOnly();
        if (denied) return denied;
        if (body.confirm_wipe !== "RESET") return Response.json({ error: "CONFIRMATION_REQUIRED", message: "Pass confirm_wipe: \"RESET\" to wipe every gift." }, { status: 400 });
        backups.snapshot("pre-reset");
        db.transaction(() => {
          db.exec(`DELETE FROM ledger; DELETE FROM held_donations; DELETE FROM active_card; DELETE FROM fundraising_receipt;`);
          const current = getEventState(db);
          updateEventState(db, { odometer_floor_cents: 0, stage_reset_seq: current.stage_reset_seq + 1, is_frozen: 0 });
        })();
        audit(db, operator.accountId, "reset_ledger");
        break;
      }
      case "list_backups": {
        const denied = adminOnly();
        if (denied) return denied;
        return Response.json({ ok: true, dir: backups.dir, backups: backups.list() });
      }
      case "create_backup": {
        const denied = adminOnly();
        if (denied) return denied;
        const info = backups.snapshot("manual");
        audit(db, operator.accountId, "create_backup", info.name);
        return Response.json({ ok: true, backup: info, backups: backups.list() });
      }
      case "restore_backup": {
        const denied = adminOnly();
        if (denied) return denied;
        if (body.confirm !== "RESTORE") return Response.json({ error: "CONFIRMATION_REQUIRED", message: "Pass confirm: \"RESTORE\" to replace the current gifts and settings." }, { status: 400 });
        const result = backups.restore(String(body.name || ""));
        audit(db, operator.accountId, "restore_backup", result.restored.name);
        return Response.json({ ok: true, ...result, state: getControlState(db) });
      }
      case "create_account": {
        const denied = adminOnly();
        if (denied) return denied;
        const username = normalizeUsername(body.username);
        const displayName = String(body.displayName || "").trim().slice(0, 80);
        const pin = String(body.pin || "");
        const role = String(body.role || "operator");
        if (!username || !displayName || pin.length < 4 || pin.length > 12 || !["admin", "operator"].includes(role)) {
          return Response.json({ error: "INVALID_ACCOUNT", message: "Name, display name, 4-12 character PIN, and admin/operator role are required." }, { status: 400 });
        }
        const id = crypto.randomUUID();
        try {
          db.query(`INSERT INTO operator_account (id, username, display_name, pin_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(id, username, displayName, await Bun.password.hash(pin), role, Date.now());
        } catch {
          return Response.json({ error: "ACCOUNT_EXISTS", message: "That operator name already exists." }, { status: 409 });
        }
        audit(db, operator.accountId, "create_account", id);
        return Response.json({ ok: true, id });
      }
      case "update_account": {
        const denied = adminOnly();
        if (denied) return denied;
        const id = String(body.id || "");
        if (!db.query<{ id: string }, [string]>(`SELECT id FROM operator_account WHERE id = ?`).get(id)) return Response.json({ error: "NOT_FOUND", message: "Operator not found." }, { status: 404 });
        const displayName = body.displayName !== undefined ? String(body.displayName || "").trim().slice(0, 80) : undefined;
        const role = body.role !== undefined ? String(body.role) : undefined;
        const pin = body.pin !== undefined ? String(body.pin) : undefined;
        const disabled = body.disabled !== undefined ? Boolean(body.disabled) : undefined;
        if (displayName !== undefined && !displayName) return Response.json({ error: "INVALID_ACCOUNT", message: "Display name cannot be empty." }, { status: 400 });
        if (role !== undefined && !["admin", "operator"].includes(role)) return Response.json({ error: "INVALID_ACCOUNT", message: "Role must be admin or operator." }, { status: 400 });
        if (pin !== undefined && pin !== "" && (pin.length < 4 || pin.length > 12)) return Response.json({ error: "INVALID_PIN", message: "PIN must be 4-12 characters." }, { status: 400 });
        if (id === operator.accountId && (disabled || (role !== undefined && role !== "admin"))) return Response.json({ error: "INVALID_ACCOUNT", message: "You cannot disable or demote your own administrator account." }, { status: 400 });
        if (displayName !== undefined) db.query(`UPDATE operator_account SET display_name = ? WHERE id = ?`).run(displayName, id);
        if (role !== undefined) db.query(`UPDATE operator_account SET role = ? WHERE id = ?`).run(role, id);
        if (pin) {
          db.query(`UPDATE operator_account SET pin_hash = ? WHERE id = ?`).run(await Bun.password.hash(pin), id);
          db.query(`DELETE FROM operator_session WHERE account_id = ?`).run(id);
        }
        if (disabled !== undefined) {
          db.query(`UPDATE operator_account SET disabled = ? WHERE id = ?`).run(disabled ? 1 : 0, id);
          if (disabled) db.query(`DELETE FROM operator_session WHERE account_id = ?`).run(id);
        }
        audit(db, operator.accountId, "update_account", id);
        return Response.json({ ok: true });
      }
      case "create_invite_link": {
        const denied = adminOnly();
        if (denied) return denied;
        try {
          const issued = createInviteLink(db, req, String(body.id || ""));
          audit(db, operator.accountId, "create_invite_link", String(body.id || ""));
          return Response.json({ ok: true, ...issued });
        } catch (error) {
          return Response.json({ error: "INVITE_FAILED", message: error instanceof Error ? error.message : "Could not create the link." }, { status: 400 });
        }
      }
      case "send_invite": {
        const denied = adminOnly();
        if (denied) return denied;
        const id = String(body.id || "");
        try {
          const { link } = await createInvite(db, req, id, String(body.email || ""));
          audit(db, operator.accountId, "send_invite", id);
          return Response.json({ ok: true, link });
        } catch (error) {
          return Response.json({ error: "INVITE_FAILED", message: error instanceof Error ? error.message : "Could not send invite." }, { status: 400 });
        }
      }
      case "list_accounts": {
        const denied = adminOnly();
        if (denied) return denied;
        const accounts = db.query<{ id: string; username: string; display_name: string; role: string; disabled: number; created_at: number }, []>(`SELECT id, username, display_name, role, disabled, created_at FROM operator_account ORDER BY role, username`).all();
        return Response.json({ ok: true, accounts: accounts.map(account => ({ ...account, disabled: Boolean(account.disabled) })) });
      }
      case "list_audit": {
        const denied = adminOnly();
        if (denied) return denied;
        const rows = db.query<{ actor: string | null; action: string; target: string | null; created_at: number }, []>(
          `SELECT a.username AS actor, l.action, l.target_id AS target, l.created_at FROM access_audit l LEFT JOIN operator_account a ON a.id = l.actor_id ORDER BY l.id DESC LIMIT 200`
        ).all();
        return Response.json({ ok: true, audit: rows });
      }
      default:
        return Response.json({ error: "UNKNOWN_ACTION", message: `Unknown action: ${action}` }, { status: 400 });
    }
    return Response.json({ ok: true, state: getControlState(db) });
  } catch (error) {
    return Response.json({ error: "CONTROL_ERROR", message: error instanceof Error ? error.message : "Control action failed" }, { status: 500 });
  }
}
