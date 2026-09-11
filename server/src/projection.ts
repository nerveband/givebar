import type { Database } from "bun:sqlite";
import { foldLedger, getEventState, type EventStateRecord, type FoldedLedger } from "./ledger";
import { deriveDisplayUrl, FONT_FAMILY_KEYS, CHART_ORIENTATIONS } from "./settings";

export interface PublicChyron {
  donation_id: string;
  display_name: string;
  amount_cents: number;
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

export interface TeamNote {
  id: number;
  author_id: string;
  author_name: string;
  body: string;
  created_at: number;
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

/** Event settings as every client sees them, plus the derived printed URL. */
export function publicEventState(state: EventStateRecord): EventStateRecord & { display_url_effective: string } {
  return { ...state, display_url_effective: deriveDisplayUrl(state.qr_url, state.display_url) };
}

export function getThemeTokens(state: EventStateRecord): ThemeTokens {
  return {
    preset: state.theme_preset || "champagne",
    hue: state.brand_hue,
    chroma: state.brand_chroma,
    accent_hex: state.brand_accent_hex,
    radius_px: state.brand_radius_px,
    qr_style: state.qr_style || "dots",
    qr_center_icon: state.qr_center_icon || "star",
    qr_fg_color: state.qr_fg_color,
    qr_bg_color: state.qr_bg_color || "#FFFFFF"
  };
}

/** Percent milestones resolve against the live goal so goal edits move them instantly. */
export function getMilestones(db: Database, goalCents: number): MilestoneItem[] {
  return db.query<{ id: number; sort_order: number; percent_of_goal: number | null; cents: number | null; label: string; celebrate: number }, []>(`SELECT * FROM milestone ORDER BY sort_order ASC`).all()
    .map(row => ({
      id: row.id,
      sort_order: row.sort_order,
      percent_of_goal: row.percent_of_goal,
      cents: row.cents || (row.percent_of_goal ? Math.round((goalCents * row.percent_of_goal) / 100) : 0),
      label: row.label,
      celebrate: Boolean(row.celebrate)
    }));
}

export function getAskTiers(db: Database): AskTierItem[] {
  return db.query<AskTierItem, []>(`SELECT id, sort_order, cents, label FROM ask_tier ORDER BY sort_order ASC`).all();
}

export function getTeamNotes(db: Database): TeamNote[] {
  return db.query<TeamNote, []>(`SELECT id, author_id, author_name, body, created_at FROM team_note ORDER BY id DESC LIMIT 100`).all();
}

function heldIds(db: Database): Set<string> {
  return new Set(db.query<{ donation_id: string }, []>(`SELECT donation_id FROM held_donations`).all().map(row => row.donation_id));
}

/**
 * Staging: a gift becomes visible stage_delay_ms after it was recorded. Until then it is
 * excluded from the staged fold entirely, so a void or amendment made inside the window
 * is honoured the moment the gift would have appeared. Once on stage, the floor ratchet
 * keeps the total from ever rolling backward; a pause freezes both figure and feed.
 */
function stagedView(db: Database, state: EventStateRecord, fullFold: FoldedLedger, now: number) {
  const horizon = now - state.stage_delay_ms;
  const hidden = heldIds(db);
  for (const record of fullFold.all_records.values()) {
    if (record.created_at > horizon) hidden.add(record.donation_id);
  }
  const stagedTotal = hidden.size ? foldLedger(db, { excludeDonationIds: hidden }).total_raised_cents : fullFold.total_raised_cents;
  // The figure on the wall: the ratcheted floor, which a pause holds in place. Any
  // observer advances the ratchet, so the floor is current even when no chart is open.
  const stageTotal = state.is_frozen ? state.odometer_floor_cents : Math.max(state.odometer_floor_cents, stagedTotal);
  if (stageTotal > state.odometer_floor_cents) db.query(`UPDATE event_state SET odometer_floor_cents = ? WHERE id = 1`).run(stageTotal);
  return { hidden, stagedTotal, stageTotal };
}

/** Audience chart projection (/chart). Public: no donor legal names, notes, or operator data. */
export function getStageState(db: Database) {
  const state = getEventState(db);
  const now = Date.now();
  const fullFold = foldLedger(db);
  const { hidden, stageTotal } = stagedView(db, state, fullFold, now);

  const chyrons: PublicChyron[] = state.is_frozen ? [] : Array.from(fullFold.active_donations.values())
    .filter(record => !hidden.has(record.donation_id))
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 30)
    .map(record => ({
      donation_id: record.donation_id,
      display_name: record.is_anonymous ? "Anonymous Supporter" : record.display_name,
      amount_cents: record.amount_cents,
      created_at: record.created_at
    }));

  return {
    seq: fullFold.latest_seq,
    event_name: state.event_name,
    event_subtitle: state.event_subtitle,
    event_title: state.event_title,
    total_raised_cents: stageTotal,
    true_total_raised_cents: fullFold.total_raised_cents,
    goal_cents: state.goal_cents,
    percent: state.goal_cents > 0 ? Math.min(100, Math.round((stageTotal / state.goal_cents) * 1000) / 10) : 0,
    is_match_active: Boolean(state.is_match_active),
    match_sponsor_title: state.match_sponsor_title,
    match_pool_cents: fullFold.derived_match_pool_cents,
    match_total_cents: state.match_total_cents,
    is_frozen: Boolean(state.is_frozen),
    stage_delay_ms: state.stage_delay_ms,
    trust_badge_text: state.trust_badge_text,
    qr_url: state.qr_url,
    display_url: state.display_url,
    display_url_effective: deriveDisplayUrl(state.qr_url, state.display_url),
    qr_style: state.qr_style,
    qr_center_icon: state.qr_center_icon,
    qr_fg_color: state.qr_fg_color,
    qr_bg_color: state.qr_bg_color,
    qr_image_url: state.qr_image_url,
    qr_image_backdrop: Boolean(state.qr_image_backdrop),
    theme: getThemeTokens(state),
    settings_seq: state.settings_seq,
    logo_url: state.logo_url,
    background_style: state.background_style,
    background_image_url: state.background_image_url,
    background_video_url: state.background_video_url,
    gradient_start: state.gradient_start,
    gradient_end: state.gradient_end,
    gradient_angle: state.gradient_angle,
    gradient_intensity: state.gradient_intensity,
    bar_color: state.bar_color,
    text_color: state.text_color,
    font_family: state.font_family,
    chart_orientation: state.chart_orientation,
    stage_reset_seq: state.stage_reset_seq,
    marker_mode: state.marker_mode,
    marker_step_cents: state.marker_step_cents,
    impact_messages: JSON.parse(state.impact_messages) as string[],
    show_qr: Boolean(state.show_qr),
    show_recent_donations: Boolean(state.show_recent_donations),
    show_live_indicator: Boolean(state.show_live_indicator),
    show_goal: Boolean(state.show_goal),
    stage_message: state.stage_message,
    stage_message_visible: Boolean(state.stage_message_visible),
    milestones: getMilestones(db, state.goal_cents),
    chyrons,
    server_time: now
  };
}

/**
 * Presenter projection (/presenter). The podium sees donor names, pronunciation, and
 * table numbers for shoutouts; it never sees team notes or which operator entered a gift.
 */
export function getEmceeState(db: Database) {
  const state = getEventState(db);
  const fullFold = foldLedger(db);
  const now = Date.now();
  const held = heldIds(db);
  const totalRaised = fullFold.total_raised_cents;

  const milestones = getMilestones(db, state.goal_cents).sort((a, b) => a.cents - b.cents);
  const upcoming = milestones.find(milestone => milestone.cents > totalRaised);
  const visible = Array.from(fullFold.active_donations.values()).filter(record => !held.has(record.donation_id));
  const shoutout = (record: (typeof visible)[number]) => ({
    donation_id: record.donation_id,
    display_name: record.is_anonymous ? "Anonymous Supporter" : record.donor_name,
    amount_cents: record.amount_cents,
    is_anonymous: record.is_anonymous,
    donor_phonetic: record.is_anonymous ? null : record.donor_phonetic,
    table_number: record.is_anonymous ? null : record.table_number,
    created_at: record.created_at
  });
  const newestFirst = [...visible].sort((a, b) => b.created_at - a.created_at);

  return {
    seq: fullFold.latest_seq,
    event_name: state.event_name,
    event_subtitle: state.event_subtitle,
    event_title: state.event_title,
    total_raised_cents: totalRaised,
    direct_raised_cents: fullFold.direct_raised_cents,
    match_applied_cents: fullFold.match_applied_cents,
    goal_cents: state.goal_cents,
    percent: state.goal_cents > 0 ? Math.min(100, Math.round((totalRaised / state.goal_cents) * 1000) / 10) : 0,
    active_donation_count: fullFold.active_donation_count,
    next_milestone: upcoming ? { target_cents: upcoming.cents, remaining_cents: upcoming.cents - totalRaised, label: upcoming.label } : null,
    is_match_active: Boolean(state.is_match_active),
    match_pool_cents: fullFold.derived_match_pool_cents,
    match_total_cents: state.match_total_cents,
    match_sponsor_title: state.match_sponsor_title,
    theme: getThemeTokens(state),
    settings_seq: state.settings_seq,
    font_family: state.font_family,
    top_gifts: [...visible].sort((a, b) => b.amount_cents - a.amount_cents).slice(0, 5).map(shoutout),
    recent_gifts: newestFirst.slice(0, 10).map(shoutout),
    all_gifts: newestFirst.slice(0, 500).map(shoutout),
    is_frozen: Boolean(state.is_frozen),
    trust_badge_text: state.trust_badge_text,
    server_time: now
  };
}

/** Operator projection (/donations, /settings, /testing). Full detail, session-gated. */
export function getControlState(db: Database) {
  const state = getEventState(db);
  const fullFold = foldLedger(db);
  const now = Date.now();
  const heldRows = db.query<{ donation_id: string; held_at: number; held_by: string; reason: string }, []>(`SELECT * FROM held_donations`).all();
  const heldById = new Map(heldRows.map(row => [row.donation_id, row]));

  const donations = Array.from(fullFold.active_donations.values())
    .sort((a, b) => b.created_at - a.created_at)
    .map(record => ({
      donation_id: record.donation_id,
      donor_name: record.donor_name,
      display_name: record.display_name,
      donor_phonetic: record.donor_phonetic,
      table_number: record.table_number,
      amount_cents: record.amount_cents,
      matched_amount_cents: record.matched_amount_cents,
      is_anonymous: record.is_anonymous,
      payment_method: record.payment_method,
      source: record.source,
      card_number: record.card_number,
      entered_by: record.entered_by,
      notes: record.notes,
      created_at: record.created_at,
      updated_at: record.updated_at,
      is_live_on_stage: now - record.created_at >= state.stage_delay_ms,
      is_held: heldById.has(record.donation_id),
      held_info: heldById.get(record.donation_id) || null
    }));

  return {
    seq: fullFold.latest_seq,
    event_state: publicEventState(state),
    font_family_options: FONT_FAMILY_KEYS,
    chart_orientation_options: CHART_ORIENTATIONS,
    theme: getThemeTokens(state),
    settings_seq: state.settings_seq,
    milestones: getMilestones(db, state.goal_cents),
    ask_tiers: getAskTiers(db),
    team_notes: getTeamNotes(db),
    folded: {
      total_raised_cents: fullFold.total_raised_cents,
      direct_raised_cents: fullFold.direct_raised_cents,
      match_applied_cents: fullFold.match_applied_cents,
      match_pool_cents: fullFold.derived_match_pool_cents,
      active_donation_count: fullFold.active_donation_count,
      void_count: fullFold.void_count
    },
    stage_preview: {
      stage_total_cents: stagedView(db, state, fullFold, now).stageTotal,
      verified_total_cents: fullFold.total_raised_cents,
      odometer_floor_cents: state.odometer_floor_cents,
      is_frozen: Boolean(state.is_frozen)
    },
    donations,
    server_time: now
  };
}

/** Add Donation form configuration. */
export function getEntryState(db: Database) {
  const state = getEventState(db);
  return {
    feature_card_number: Boolean(state.feature_card_number),
    feature_table_number: Boolean(state.feature_table_number),
    major_gift_threshold_cents: state.major_gift_threshold_cents,
    stage_delay_ms: state.stage_delay_ms,
    settings_seq: state.settings_seq,
    ask_tiers: getAskTiers(db),
    server_time: Date.now()
  };
}
