import type { Database } from "bun:sqlite";
import { foldLedger, getEventState, type DonationRecord, type LedgerEvent, type EventStateRecord } from "./ledger";
import { deriveDisplayUrl, FONT_FAMILY_KEYS, CHART_ORIENTATIONS } from "./settings";

export interface PublicChyron {
  donation_id: string;
  display_name: string;
  amount_cents: number;
  notes?: string | null;
  is_pinned?: boolean;
  created_at: number;
}

export interface MilestoneItem {
  id: number;
  sort_order: number;
  percent_of_goal: number | null;
  cents: number;
  label: string;
  celebrate: boolean;
}

export interface AskTierItem {
  id: number;
  sort_order: number;
  cents: number;
  label: string;
}

export interface ThemeTokens {
  preset: string;
  hue: number;
  chroma: number;
  accent_hex: string;
  radius_px: number;
  qr_style: string;
  qr_center_icon: string;
  qr_fg_color: string;
  qr_bg_color: string;
}

interface MilestoneRow {
  id: number;
  sort_order: number;
  percent_of_goal: number | null;
  cents: number | null;
  label: string;
  celebrate: number;
}

interface AskTierRow {
  id: number;
  sort_order: number;
  cents: number;
  label: string;
}

/**
 * Strict Privacy Shield for configuration payloads: PINs and vendor API keys
 * never leave the server, and the retired `qr_donate_url` / `milestones_json`
 * columns are dropped so no client can bind to them again.
 */
export function sanitizeEventState(state: EventStateRecord): Record<string, unknown> {
  const {
    control_pin: _controlPin,
    entry_pin: _entryPin,
    bloomerang_api_key: _apiKey,
    qr_donate_url: _retiredQrUrl,
    milestones_json: _retiredMilestones,
    ...rest
  } = state as EventStateRecord & { qr_donate_url?: string; milestones_json?: string };

  return {
    ...rest,
    display_url_effective: deriveDisplayUrl(state.qr_url, state.display_url)
  };
}

export function getThemeTokens(state: EventStateRecord): ThemeTokens {
  return {
    preset: state.theme_preset || "champagne",
    hue: state.brand_hue ?? 85,
    chroma: state.brand_chroma ?? 0.12,
    accent_hex: state.brand_accent_hex || "",
    radius_px: state.brand_radius_px ?? 12,
    qr_style: state.qr_style || "dots",
    qr_center_icon: state.qr_center_icon || "star",
    qr_fg_color: state.qr_fg_color || "",
    qr_bg_color: state.qr_bg_color || "#FFFFFF"
  };
}

/**
 * The `milestone` child table is the single source of truth. Rows may store an
 * absolute target in cents or a percent of the live goal; percent rows are
 * resolved against the current goal so goal edits move milestone math instantly.
 */
export function getMilestones(db: Database, goalCents: number): MilestoneItem[] {
  const rows = db.query<MilestoneRow, []>(`SELECT * FROM milestone ORDER BY sort_order ASC`).all();
  return rows.map((r, i) => {
    let cents = r.cents;
    if (!cents && r.percent_of_goal) {
      cents = Math.round((goalCents * r.percent_of_goal) / 100);
    }
    return {
      id: r.id || i + 1,
      sort_order: r.sort_order || i + 1,
      percent_of_goal: r.percent_of_goal ?? null,
      cents: cents || 0,
      label: r.label,
      celebrate: Boolean(r.celebrate)
    };
  });
}

export function getAskTiers(db: Database): AskTierItem[] {
  const rows = db.query<AskTierRow, []>(`SELECT * FROM ask_tier ORDER BY sort_order ASC`).all();
  return rows.map((r, i) => ({
    id: r.id || i + 1,
    sort_order: r.sort_order || i + 1,
    cents: r.cents,
    label: r.label || `$${Math.floor(r.cents / 100).toLocaleString("en-US")}`
  }));
}

/**
 * Stage Projection (/stage)
 * PURE READ: Zero DB mutations on GET.
 * Implements 8-Second Chyron Review Queue & Staged Projection.
 */
export function getStageState(db: Database, sinceSeq: number = 0) {
  const eventState = getEventState(db);
  const now = Date.now();
  const stageDelayMs = eventState.stage_delay_ms ?? 0;
  const horizon = now - stageDelayMs;

  // Held donation IDs
  const heldRows = db.query<{ donation_id: string }, []>(`SELECT donation_id FROM held_donations`).all();
  const heldSet = new Set(heldRows.map(r => r.donation_id));

  // Authoritative full fold
  const fullFold = foldLedger(db);

  // Staged fold if delay is enabled
  const stagedFold = stageDelayMs > 0
    ? foldLedger(db, { maxCreatedAt: horizon, excludeDonationIds: heldSet })
    : fullFold;

  // Determine stage total
  const stagedCalculated = stagedFold.total_raised_cents;
  // Floor ratchet applies dynamically to staged total
  const stageTotal = Math.max(stagedCalculated, eventState.odometer_floor_cents);
  if (stagedCalculated > eventState.odometer_floor_cents && !eventState.is_frozen) {
    db.query(`UPDATE event_state SET odometer_floor_cents = ? WHERE id = 1`).run(stagedCalculated);
  }

  // Milestones
  const milestones = getMilestones(db, eventState.goal_cents);

  // Delayed chyrons stream (unified with stage_delay_ms horizon, not held, privacy-shielded)
  const chyronBufferMs = stageDelayMs > 0 ? stageDelayMs : 0;
  const chyrons: PublicChyron[] = [];
  const sortedStaged = Array.from(fullFold.active_donations.values())
    .filter(d => !d.is_voided && !heldSet.has(d.donation_id))
    .sort((a, b) => b.created_at - a.created_at);

  for (const d of sortedStaged) {
    if (stageDelayMs === 0 || now - d.created_at >= chyronBufferMs) {
      chyrons.push({
        donation_id: d.donation_id,
        display_name: d.is_anonymous ? "Anonymous Supporter" : d.display_name,
        amount_cents: d.amount_cents,
        notes: d.is_anonymous ? null : d.notes,
        created_at: d.created_at
      });
    }
  }

  const percent = eventState.goal_cents > 0
    ? Math.min(100, Math.round((stageTotal / eventState.goal_cents) * 1000) / 10)
    : 0;

  // Check pinned donation
  let pinnedDonation = null;
  if (eventState.pinned_donation_id) {
    const pinned = fullFold.active_donations.get(eventState.pinned_donation_id);
    if (pinned && !pinned.is_voided) {
      pinnedDonation = {
        donation_id: pinned.donation_id,
        display_name: pinned.is_anonymous ? "Anonymous Supporter" : pinned.display_name,
        amount_cents: pinned.amount_cents,
        notes: pinned.is_anonymous ? null : (pinned.notes || null),
        created_at: pinned.created_at
      };
    }
  }

  return {
    seq: fullFold.latest_seq,
    event_name: eventState.event_name,
    event_subtitle: eventState.event_subtitle,
    total_raised_cents: stageTotal,
    true_total_raised_cents: fullFold.total_raised_cents,
    verified_total_cents: fullFold.total_raised_cents,
    goal_cents: eventState.goal_cents,
    percent,
    is_match_active: Boolean(eventState.is_match_active),
    match_sponsor_title: eventState.match_sponsor_title,
    match_pool_cents: fullFold.derived_match_pool_cents,
    match_total_cents: eventState.match_total_cents,
    is_frozen: Boolean(eventState.is_frozen),
    countdown_seconds: eventState.countdown_seconds ?? 300,
    timer_status: eventState.timer_status || "stopped",
    timer_ends_at: eventState.timer_ends_at ?? null,
    thermometer_visual_mode: eventState.thermometer_visual_mode || "classic",
    embed_media_url: eventState.embed_media_url || "",
    trust_badge_text: eventState.trust_badge_text || "501(c)(3) Tax-Deductible Contribution",
    pinned_donation_id: eventState.pinned_donation_id ?? null,
    pinned_donation: pinnedDonation,
    qr_url: eventState.qr_url || "",
    display_url: eventState.display_url || "",
    display_url_effective: deriveDisplayUrl(eventState.qr_url, eventState.display_url),
    qr_style: eventState.qr_style || "dots",
    qr_center_icon: eventState.qr_center_icon || "star",
    qr_fg_color: eventState.qr_fg_color || "",
    qr_bg_color: eventState.qr_bg_color || "#FFFFFF",
    theme: getThemeTokens(eventState),
    settings_seq: eventState.settings_seq || 1,
    has_control_pin: Boolean(eventState.control_pin && eventState.control_pin.trim() !== ""),
    logo_url: eventState.logo_url || "",
    background_style: eventState.background_style || "plain",
    bar_color: eventState.bar_color || "",
    event_title: eventState.event_title || "",
    text_color: eventState.text_color || "",
    font_family: eventState.font_family || "system",
    chart_orientation: eventState.chart_orientation || "horizontal",
    stage_reset_seq: eventState.stage_reset_seq,
    marker_mode: eventState.marker_mode,
    marker_step_cents: eventState.marker_step_cents,
    background_image_url: eventState.background_image_url,
    gradient_start: eventState.gradient_start,
    gradient_end: eventState.gradient_end,
    gradient_angle: eventState.gradient_angle,
    gradient_intensity: eventState.gradient_intensity,
    background_video_url: eventState.background_video_url,
    impact_messages: JSON.parse(eventState.impact_messages),
    qr_image_url: eventState.qr_image_url,
    qr_image_backdrop: Boolean(eventState.qr_image_backdrop),
    show_qr: Boolean(eventState.show_qr ?? 1),
    show_recent_donations: Boolean(eventState.show_recent_donations ?? 1),
    show_live_indicator: Boolean(eventState.show_live_indicator ?? 1),
    show_goal: Boolean(eventState.show_goal ?? 1),
    stage_message: eventState.stage_message || "",
    stage_message_visible: Boolean(eventState.stage_message_visible ?? 0),
    feature_timer: Boolean(eventState.feature_timer ?? 0),
    milestones,
    chyrons: chyrons.slice(0, 30),
    server_time: now
  };
}

/**
 * Emcee Podium Screen Projection (/emcee)
 * High-contrast OLED confidence monitor with 3-second glance shoutout cards.
 */
export function getEmceeState(db: Database) {
  const eventState = getEventState(db);
  const fullFold = foldLedger(db);
  const now = Date.now();

  const totalRaised = fullFold.total_raised_cents;

  const milestones = getMilestones(db, eventState.goal_cents);
  milestones.sort((a, b) => a.cents - b.cents);

  let nextMilestone: { target_cents: number; remaining_cents: number; label: string } | null = null;
  for (const m of milestones) {
    if (m.cents > totalRaised) {
      nextMilestone = {
        target_cents: m.cents,
        remaining_cents: m.cents - totalRaised,
        label: m.label
      };
      break;
    }
  }

  const heldRows = db.query<{ donation_id: string }, []>(`SELECT donation_id FROM held_donations`).all();
  const heldSet = new Set(heldRows.map(r => r.donation_id));

  // Top 5 largest gifts for vocal shoutouts (excludes held items, includes table number & phonetic guide)
  const topGifts = Array.from(fullFold.active_donations.values())
    .filter(d => !heldSet.has(d.donation_id) && !d.is_voided)
    .sort((a, b) => b.amount_cents - a.amount_cents)
    .slice(0, 5)
    .map(d => ({
      donation_id: d.donation_id,
      display_name: d.is_anonymous ? "Anonymous Supporter" : d.donor_name,
      amount_cents: d.amount_cents,
      is_anonymous: Boolean(d.is_anonymous),
      donor_phonetic: d.is_anonymous ? null : (d.donor_phonetic || null),
      table_number: d.is_anonymous ? null : (d.table_number || null),
      notes: d.is_anonymous ? null : (d.notes || null),
      entered_by: d.is_anonymous ? null : (d.entered_by || null)
    }));

  // Recent 10 gifts for stream pacing (excludes held items)
  const recentGifts = Array.from(fullFold.active_donations.values())
    .filter(d => !heldSet.has(d.donation_id) && !d.is_voided)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 10)
    .map(d => ({
      donation_id: d.donation_id,
      display_name: d.is_anonymous ? "Anonymous Supporter" : d.donor_name,
      amount_cents: d.amount_cents,
      is_anonymous: Boolean(d.is_anonymous),
      donor_phonetic: d.is_anonymous ? null : (d.donor_phonetic || null),
      table_number: d.is_anonymous ? null : (d.table_number || null),
      notes: d.is_anonymous ? null : (d.notes || null),
      created_at: d.created_at,
      seconds_ago: Math.max(0, Math.floor((now - d.created_at) / 1000))
    }));

  // Full presenter history: every active gift, newest first, same privacy shield.
  const allGifts = Array.from(fullFold.active_donations.values())
    .filter(d => !heldSet.has(d.donation_id) && !d.is_voided)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 500)
    .map(d => ({
      donation_id: d.donation_id,
      display_name: d.is_anonymous ? "Anonymous Supporter" : d.donor_name,
      amount_cents: d.amount_cents,
      is_anonymous: Boolean(d.is_anonymous),
      donor_phonetic: d.is_anonymous ? null : (d.donor_phonetic || null),
      created_at: d.created_at
    }));

  const percent = eventState.goal_cents > 0
    ? Math.min(100, Math.round((totalRaised / eventState.goal_cents) * 1000) / 10)
    : 0;

  return {
    seq: fullFold.latest_seq,
    event_name: eventState.event_name,
    event_subtitle: eventState.event_subtitle,
    event_title: eventState.event_title || "",
    total_raised_cents: totalRaised,
    direct_raised_cents: fullFold.direct_raised_cents,
    match_applied_cents: fullFold.match_applied_cents,
    goal_cents: eventState.goal_cents,
    percent,
    active_donation_count: fullFold.active_donation_count,
    next_milestone: nextMilestone,
    is_match_active: Boolean(eventState.is_match_active),
    match_pool_cents: fullFold.derived_match_pool_cents,
    match_total_cents: eventState.match_total_cents,
    match_sponsor_title: eventState.match_sponsor_title,
    theme: getThemeTokens(eventState),
    settings_seq: eventState.settings_seq || 1,
    top_gifts: topGifts,
    recent_gifts: recentGifts,
    all_gifts: allGifts,
    is_frozen: Boolean(eventState.is_frozen),
    countdown_seconds: eventState.countdown_seconds ?? 300,
    timer_status: eventState.timer_status || "stopped",
    timer_ends_at: eventState.timer_ends_at ?? null,
    trust_badge_text: eventState.trust_badge_text || "501(c)(3) Tax-Deductible Contribution",
    server_time: now
  };
}

/**
 * Event Control Room Projection (/control)
 * Full operational visibility: 8s Review Queue with hold cues, live reconciliation drift banner, and audit log.
 */
export function getControlState(db: Database) {
  const eventState = getEventState(db);
  const fullFold = foldLedger(db);
  const now = Date.now();
  const chyronBufferMs = 8000;

  const heldRows = db.query<{ donation_id: string; held_at: number; held_by: string; reason: string }, []>(
    `SELECT * FROM held_donations`
  ).all();
  const heldMap = new Map(heldRows.map(r => [r.donation_id, r]));

  const stageDisplayTotal = Math.max(
    fullFold.total_raised_cents,
    eventState.odometer_floor_cents
  );

  // Staging queue: Donations from the last 90 seconds
  const stagedChyrons = Array.from(fullFold.active_donations.values())
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 50)
    .map(d => {
      const elapsedMs = now - d.created_at;
      const isLiveOnStage = elapsedMs >= chyronBufferMs;
      const remainingDelaySec = isLiveOnStage ? 0 : Math.ceil((chyronBufferMs - elapsedMs) / 1000);
      const heldInfo = heldMap.get(d.donation_id);

      return {
        donation_id: d.donation_id,
        donor_name: d.donor_name,
        display_name: d.display_name,
        donor_phonetic: d.donor_phonetic || null,
        table_number: d.table_number || null,
        amount_cents: d.amount_cents,
        is_anonymous: d.is_anonymous,
        payment_method: d.payment_method,
        source: d.source,
        card_number: d.card_number,
        entered_by: d.entered_by,
        notes: d.notes,
        created_at: d.created_at,
        elapsed_sec: Math.floor(elapsedMs / 1000),
        remaining_delay_sec: remainingDelaySec,
        is_live_on_stage: isLiveOnStage,
        is_held: Boolean(heldInfo),
        is_yanked: Boolean(heldInfo),
        held_info: heldInfo || null,
        yank_info: heldInfo || null
      };
    });

  // Recent 50 ledger events
  const recentEvents = db.query<LedgerEvent, []>(
    `SELECT * FROM ledger ORDER BY seq DESC LIMIT 50`
  ).all();

  const sanitizedState = sanitizeEventState(eventState);
  const hasBloomerangKey = Boolean(eventState.bloomerang_api_key && eventState.bloomerang_api_key.trim() !== "");
  const bloomerangKeyMasked = hasBloomerangKey ? "••••••••••••••" : "";
  return {
    seq: fullFold.latest_seq,
    event_state: sanitizedState,
    has_control_pin: Boolean(eventState.control_pin && eventState.control_pin.trim() !== ""),
    has_entry_pin: Boolean(eventState.entry_pin && eventState.entry_pin.trim() !== ""),
    has_bloomerang_api_key: hasBloomerangKey,
    bloomerang_key_masked: bloomerangKeyMasked,
    display_url_effective: deriveDisplayUrl(eventState.qr_url, eventState.display_url),
    font_family_options: FONT_FAMILY_KEYS,
    chart_orientation_options: CHART_ORIENTATIONS,
    theme: getThemeTokens(eventState),
    settings_seq: eventState.settings_seq || 1,
    milestones: getMilestones(db, eventState.goal_cents),
    ask_tiers: getAskTiers(db),
    folded: {
      total_raised_cents: fullFold.total_raised_cents,
      direct_raised_cents: fullFold.direct_raised_cents,
      match_applied_cents: fullFold.match_applied_cents,
      match_pool_cents: fullFold.derived_match_pool_cents,
      active_donation_count: fullFold.active_donation_count,
      void_count: fullFold.void_count
    },
    stage_preview: {
      stage_total_cents: stageDisplayTotal,
      verified_total_cents: fullFold.total_raised_cents,
      odometer_floor_cents: eventState.odometer_floor_cents,
      is_frozen: Boolean(eventState.is_frozen)
    },
    staged_chyrons: stagedChyrons,
    recent_events: recentEvents,
    server_time: now
  };
}

/**
 * Volunteer Pledge Pad Projection (/entry)
 * Returns ask tiers, personal audit log, and sanitized connection state.
 */
export function getVolunteerState(db: Database, displayName?: string) {
  const eventState = getEventState(db);
  const fullFold = foldLedger(db);
  const now = Date.now();

  let personalLog: DonationRecord[] = [];
  if (displayName) {
    personalLog = Array.from(fullFold.all_records.values())
      .filter(d => d.entered_by === displayName)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 20);
  }

  return {
    seq: fullFold.latest_seq,
    theme: getThemeTokens(eventState),
    feature_card_number: Boolean(eventState.feature_card_number ?? 0),
    feature_table_number: Boolean(eventState.feature_table_number ?? 0),
    feature_timer: Boolean(eventState.feature_timer ?? 0),
    event_title: eventState.event_title || "",
    event_name: eventState.event_name,
    event_subtitle: eventState.event_subtitle,
    total_raised_cents: fullFold.total_raised_cents,
    goal_cents: eventState.goal_cents,
    major_gift_threshold_cents: eventState.major_gift_threshold_cents || 950000,
    font_family: eventState.font_family || "system",
    text_color: eventState.text_color || "",
    settings_seq: eventState.settings_seq || 1,
    ask_tiers: getAskTiers(db),
    personal_log: personalLog,
    server_time: now
  };
}
