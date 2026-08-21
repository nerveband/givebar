import type { Database } from "bun:sqlite";
import { foldLedger, getEventState, type DonationRecord, type LedgerEvent, type EventStateRecord } from "./ledger";

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

export function getMilestones(db: Database, goalCents: number): MilestoneItem[] {
  const eventState = getEventState(db);

  // If milestones_json is customized, parse it
  if (eventState.milestones_json) {
    try {
      const parsed: Array<{ cents: number; label: string; percent?: number; celebrate?: boolean }> = JSON.parse(eventState.milestones_json);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((m, i) => ({
          id: i + 1,
          sort_order: i + 1,
          percent_of_goal: m.percent !== undefined ? m.percent : (goalCents > 0 ? (m.cents / goalCents) * 100 : null),
          cents: m.cents,
          label: m.label,
          celebrate: m.celebrate !== undefined ? Boolean(m.celebrate) : true
        }));
      }
    } catch {
      // Fall through to milestone table
    }
  }

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
  const rawStageTotal = eventState.manual_override_cents !== null && eventState.manual_override_cents !== undefined
    ? eventState.manual_override_cents
    : stagedCalculated;

  // Floor ratchet applies only to delayed/staged total
  const stageTotal = Math.max(rawStageTotal, eventState.odometer_floor_cents);

  // Milestones
  const milestones = getMilestones(db, eventState.goal_cents);

  // Delayed chyrons stream (older than 8s chyron buffer, not held, privacy-shielded)
  const chyronBufferMs = 8000;
  const chyrons: PublicChyron[] = [];
  const sortedStaged = Array.from(fullFold.active_donations.values())
    .filter(d => !d.is_voided && !heldSet.has(d.donation_id))
    .sort((a, b) => b.created_at - a.created_at);

  for (const d of sortedStaged) {
    if (now - d.created_at >= chyronBufferMs || stageDelayMs === 0) {
      chyrons.push({
        donation_id: d.donation_id,
        display_name: d.is_anonymous ? "Anonymous Supporter" : d.display_name,
        amount_cents: d.amount_cents,
        created_at: d.created_at
      });
    }
  }

  const percent = eventState.goal_cents > 0
    ? Math.min(100, Math.round((stageTotal / eventState.goal_cents) * 1000) / 10)
    : 0;

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
    qr_donate_url: eventState.qr_donate_url,
    qr_style: eventState.qr_style || "dots",
    qr_center_icon: eventState.qr_center_icon || "star",
    qr_fg_color: eventState.qr_fg_color || "",
    qr_bg_color: eventState.qr_bg_color || "#FFFFFF",
    theme: getThemeTokens(eventState),
    settings_seq: eventState.settings_seq || 1,
    milestones,
    chyrons: chyrons.slice(0, 30),
    confetti_trigger: eventState.confetti_trigger,
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

  const totalRaised = eventState.manual_override_cents !== null && eventState.manual_override_cents !== undefined
    ? eventState.manual_override_cents
    : fullFold.total_raised_cents;

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

  // Top 5 largest gifts for vocal shoutouts (includes table number & phonetic guide)
  const topGifts = Array.from(fullFold.active_donations.values())
    .sort((a, b) => b.amount_cents - a.amount_cents)
    .slice(0, 5)
    .map(d => ({
      donation_id: d.donation_id,
      display_name: d.is_anonymous ? "Anonymous Supporter" : d.donor_name,
      amount_cents: d.amount_cents,
      is_anonymous: d.is_anonymous,
      donor_phonetic: d.donor_phonetic || null,
      table_number: d.table_number || null,
      notes: d.notes,
      entered_by: d.entered_by
    }));

  // Recent 10 gifts for stream pacing
  const recentGifts = Array.from(fullFold.active_donations.values())
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 10)
    .map(d => ({
      donation_id: d.donation_id,
      display_name: d.is_anonymous ? "Anonymous Supporter" : d.donor_name,
      amount_cents: d.amount_cents,
      is_anonymous: d.is_anonymous,
      donor_phonetic: d.donor_phonetic || null,
      table_number: d.table_number || null,
      notes: d.notes,
      created_at: d.created_at,
      seconds_ago: Math.max(0, Math.floor((now - d.created_at) / 1000))
    }));

  const percent = eventState.goal_cents > 0
    ? Math.min(100, Math.round((totalRaised / eventState.goal_cents) * 1000) / 10)
    : 0;

  return {
    seq: fullFold.latest_seq,
    event_name: eventState.event_name,
    event_subtitle: eventState.event_subtitle,
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
    is_frozen: Boolean(eventState.is_frozen),
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
    eventState.manual_override_cents !== null && eventState.manual_override_cents !== undefined
      ? eventState.manual_override_cents
      : fullFold.total_raised_cents,
    eventState.odometer_floor_cents
  );

  const driftCents = stageDisplayTotal - fullFold.total_raised_cents;

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

  // Sanitize state payload (omit PINs from state object)
  const { control_pin: _c, entry_pin: _e, ...sanitizedState } = eventState;

  return {
    seq: fullFold.latest_seq,
    event_state: sanitizedState,
    has_control_pin: Boolean(eventState.control_pin && eventState.control_pin.trim() !== ""),
    has_entry_pin: Boolean(eventState.entry_pin && eventState.entry_pin.trim() !== ""),
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
      drift_cents: driftCents,
      is_drifted: driftCents !== 0,
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
export function getVolunteerState(db: Database, volunteerId?: string) {
  const eventState = getEventState(db);
  const fullFold = foldLedger(db);
  const now = Date.now();

  let personalLog: DonationRecord[] = [];
  if (volunteerId) {
    personalLog = Array.from(fullFold.all_records.values())
      .filter(d => d.entered_by === volunteerId)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 20);
  }

  return {
    seq: fullFold.latest_seq,
    event_name: eventState.event_name,
    event_subtitle: eventState.event_subtitle,
    total_raised_cents: fullFold.total_raised_cents,
    goal_cents: eventState.goal_cents,
    major_gift_threshold_cents: eventState.major_gift_threshold_cents || 950000,
    has_entry_pin: Boolean(eventState.entry_pin && eventState.entry_pin.trim() !== ""),
    theme: getThemeTokens(eventState),
    settings_seq: eventState.settings_seq || 1,
    ask_tiers: getAskTiers(db),
    personal_log: personalLog,
    server_time: now
  };
}
