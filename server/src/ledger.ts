import type { Database } from "bun:sqlite";

export type DonationSource = "manual" | "bloomerang" | "rehearsal";
export type PaymentMethod = "pledge" | "card" | "check" | "cash" | "match";

export interface LedgerEvent {
  seq: number;
  event_type: "create" | "amend" | "void" | "restore" | "match_apply" | "match_release";
  donation_id: string;
  supersedes_seq: number | null;
  amount_cents: number;
  donor_name: string;
  display_name: string | null;
  is_anonymous: number;
  payment_method: PaymentMethod;
  source: DonationSource;
  source_txn_id: string | null;
  card_number: string | null;
  entered_by: string | null;
  notes: string | null;
  donor_phonetic: string | null;
  table_number: string | null;
  created_at: number;
}

export interface DonationRecord {
  donation_id: string;
  latest_seq: number;
  amount_cents: number;
  donor_name: string;
  display_name: string;
  is_anonymous: boolean;
  payment_method: string;
  source: string;
  card_number: string | null;
  entered_by: string | null;
  notes: string | null;
  donor_phonetic: string | null;
  table_number: string | null;
  created_at: number;
  updated_at: number;
  is_voided: boolean;
  matched_amount_cents: number;
}

export interface EventStateRecord {
  id: number;
  event_name: string;
  event_subtitle: string;
  event_title: string;
  goal_cents: number;
  match_total_cents: number;
  match_ratio: number;
  is_match_active: number;
  match_sponsor_title: string;
  is_frozen: number;
  qr_url: string;
  display_url: string;
  qr_style: string;
  qr_center_icon: string;
  qr_fg_color: string;
  qr_bg_color: string;
  qr_image_url: string;
  qr_image_backdrop: number;
  odometer_floor_cents: number;
  stage_reset_seq: number;
  theme_preset: string;
  brand_hue: number;
  brand_chroma: number;
  brand_accent_hex: string;
  brand_radius_px: number;
  major_gift_threshold_cents: number;
  stage_delay_ms: number;
  trust_badge_text: string;
  logo_url: string;
  background_style: string;
  background_image_url: string;
  background_video_url: string;
  gradient_start: string;
  gradient_end: string;
  gradient_angle: number;
  gradient_intensity: number;
  bar_color: string;
  text_color: string;
  font_family: string;
  chart_orientation: string;
  marker_mode: string;
  marker_step_cents: number;
  show_qr: number;
  show_recent_donations: number;
  show_live_indicator: number;
  show_goal: number;
  stage_message: string;
  stage_message_visible: number;
  impact_messages: string;
  feature_card_number: number;
  feature_table_number: number;
  settings_seq: number;
  updated_at: number;
}

/** Columns an operator may change through updateEventState; everything else is derived or system-owned. */
const EVENT_STATE_COLUMNS: (keyof EventStateRecord)[] = [
  "event_name", "event_subtitle", "event_title", "goal_cents", "match_total_cents", "match_ratio", "is_match_active",
  "match_sponsor_title", "is_frozen", "qr_url", "display_url", "qr_style", "qr_center_icon", "qr_fg_color", "qr_bg_color",
  "qr_image_url", "qr_image_backdrop", "odometer_floor_cents", "stage_reset_seq", "theme_preset", "brand_hue", "brand_chroma",
  "brand_accent_hex", "brand_radius_px", "major_gift_threshold_cents", "stage_delay_ms", "trust_badge_text", "logo_url",
  "background_style", "background_image_url", "background_video_url", "gradient_start", "gradient_end", "gradient_angle",
  "gradient_intensity", "bar_color", "text_color", "font_family", "chart_orientation", "marker_mode", "marker_step_cents",
  "show_qr", "show_recent_donations", "show_live_indicator", "show_goal", "stage_message", "stage_message_visible",
  "impact_messages", "feature_card_number", "feature_table_number"
];

export interface FoldOptions {
  /** Donations (and their matching events) left out of the fold entirely. */
  excludeDonationIds?: Set<string>;
}

export interface FoldedLedger {
  direct_raised_cents: number;
  match_applied_cents: number;
  derived_match_pool_cents: number;
  total_raised_cents: number;
  active_donation_count: number;
  void_count: number;
  active_donations: Map<string, DonationRecord>;
  all_records: Map<string, DonationRecord>;
  match_by_parent: Map<string, number>;
  latest_seq: number;
  last_event_at: number;
}

export interface CreateDonationInput {
  donation_id: string;
  amount_cents: number;
  donor_name: string;
  display_name?: string;
  is_anonymous?: boolean;
  payment_method?: PaymentMethod;
  source?: DonationSource;
  source_txn_id?: string;
  card_number?: string;
  entered_by?: string;
  notes?: string;
  donor_phonetic?: string;
  table_number?: string;
  confirmed_major_gift?: boolean;
  confirmed_duplicate?: boolean;
}

export class MajorGiftConfirmationRequiredError extends Error {
  constructor(public amount_cents: number, public threshold_cents: number) {
    super(`Gifts of $${Math.floor(threshold_cents / 100).toLocaleString("en-US")} or more require explicit confirmation.`);
    this.name = "MajorGiftConfirmationRequiredError";
  }
}


export class CardSerialCollisionError extends Error {
  constructor(
    public card_number: string,
    public prior_donation_id: string,
    public prior_entered_by: string | null,
    public prior_created_at: number,
    public prior_amount_cents: number,
    public prior_donor_name: string
  ) {
    super(`Physical pledge card #${card_number} was already entered by ${prior_entered_by || "another operator"}.`);
    this.name = "CardSerialCollisionError";
  }
}

/** Same donor and same amount recorded moments ago: almost always two people entering one gift. */
export class PossibleDuplicateError extends Error {
  constructor(
    public prior_donation_id: string,
    public prior_donor_name: string,
    public prior_amount_cents: number,
    public prior_entered_by: string | null,
    public prior_created_at: number
  ) {
    super(`A gift of the same amount from ${prior_donor_name} was recorded moments ago by ${prior_entered_by || "another operator"}.`);
    this.name = "PossibleDuplicateError";
  }
}

export const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

export function normalizeCard(card?: string | null): string | null {
  if (!card) return null;
  const trimmed = card.trim().replace(/^#/, "").toUpperCase();
  return trimmed === "" ? null : trimmed;
}

function normalizeDonor(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Deterministic fold over the immutable event ledger. Excluded donations are
 * removed wholesale (create, amend, void, restore, and matching events), which
 * is what lets the stage projection hide a gift without ever seeing a stale
 * version of it.
 */
export function foldLedger(db: Database, options?: FoldOptions): FoldedLedger {
  const events = db.query<LedgerEvent, []>(`SELECT * FROM ledger ORDER BY seq ASC`).all();
  const matchTotal = db.query<{ match_total_cents: number }, []>(`SELECT match_total_cents FROM event_state WHERE id = 1`).get()!.match_total_cents;
  const excluded = options?.excludeDonationIds;

  const activeDonations = new Map<string, DonationRecord>();
  const allRecords = new Map<string, DonationRecord>();
  const matchByParent = new Map<string, number>();
  let matchAppliedCents = 0;
  let voidCount = 0;
  let latestSeq = 0;
  let lastEventAt = 0;

  for (const event of events) {
    latestSeq = event.seq;
    lastEventAt = event.created_at;
    const parentId = event.donation_id.replace(/^match_/, "");
    if (excluded?.has(parentId)) continue;

    if (event.event_type === "match_apply") {
      matchAppliedCents += event.amount_cents;
      matchByParent.set(parentId, (matchByParent.get(parentId) || 0) + event.amount_cents);
      continue;
    }
    if (event.event_type === "match_release") {
      matchAppliedCents = Math.max(0, matchAppliedCents - event.amount_cents);
      const remaining = Math.max(0, (matchByParent.get(parentId) || 0) - event.amount_cents);
      if (remaining === 0) matchByParent.delete(parentId);
      else matchByParent.set(parentId, remaining);
      continue;
    }

    if (event.event_type === "create") {
      const record: DonationRecord = {
        donation_id: event.donation_id,
        latest_seq: event.seq,
        amount_cents: event.amount_cents,
        donor_name: event.donor_name,
        display_name: event.display_name || (event.is_anonymous ? "Anonymous Supporter" : event.donor_name),
        is_anonymous: Boolean(event.is_anonymous),
        payment_method: event.payment_method,
        source: event.source,
        card_number: event.card_number,
        entered_by: event.entered_by,
        notes: event.notes,
        donor_phonetic: event.donor_phonetic,
        table_number: event.table_number,
        created_at: event.created_at,
        updated_at: event.created_at,
        is_voided: false,
        matched_amount_cents: 0
      };
      activeDonations.set(event.donation_id, record);
      allRecords.set(event.donation_id, record);
      continue;
    }

    const existing = allRecords.get(event.donation_id);
    if (!existing) continue;
    if (event.event_type === "amend" && !existing.is_voided) {
      existing.latest_seq = event.seq;
      existing.amount_cents = event.amount_cents;
      existing.donor_name = event.donor_name;
      existing.display_name = event.display_name || (event.is_anonymous ? "Anonymous Supporter" : event.donor_name);
      existing.is_anonymous = Boolean(event.is_anonymous);
      existing.payment_method = event.payment_method;
      existing.card_number = event.card_number;
      existing.entered_by = event.entered_by || existing.entered_by;
      existing.notes = event.notes;
      existing.donor_phonetic = event.donor_phonetic ?? existing.donor_phonetic;
      existing.table_number = event.table_number ?? existing.table_number;
      existing.updated_at = event.created_at;
    } else if (event.event_type === "void") {
      existing.latest_seq = event.seq;
      existing.is_voided = true;
      existing.updated_at = event.created_at;
      activeDonations.delete(event.donation_id);
      voidCount++;
    } else if (event.event_type === "restore") {
      existing.latest_seq = event.seq;
      existing.is_voided = false;
      existing.updated_at = event.created_at;
      activeDonations.set(event.donation_id, existing);
      voidCount = Math.max(0, voidCount - 1);
    }
  }

  let directRaisedCents = 0;
  for (const record of activeDonations.values()) {
    directRaisedCents += record.amount_cents;
    record.matched_amount_cents = matchByParent.get(record.donation_id) || 0;
  }

  return {
    direct_raised_cents: directRaisedCents,
    match_applied_cents: matchAppliedCents,
    derived_match_pool_cents: Math.max(0, matchTotal - matchAppliedCents),
    total_raised_cents: directRaisedCents + matchAppliedCents,
    active_donation_count: activeDonations.size,
    void_count: voidCount,
    active_donations: activeDonations,
    all_records: allRecords,
    match_by_parent: matchByParent,
    latest_seq: latestSeq,
    last_event_at: lastEventAt
  };
}

const INSERT_EVENT = `
  INSERT INTO ledger (
    event_type, donation_id, supersedes_seq, amount_cents, donor_name, display_name, is_anonymous,
    payment_method, source, source_txn_id, card_number, entered_by, notes, donor_phonetic, table_number, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function insertMatchEvent(db: Database, type: "match_apply" | "match_release", donationId: string, supersedesSeq: number, cents: number, title: string, note: string, now: number): void {
  db.query(INSERT_EVENT).run(type, `match_${donationId}`, supersedesSeq, cents, title, title, 0, "match", "manual", null, null, "MATCH_ENGINE", note, null, null, now);
}

/** Applies the sponsor match for one gift against whatever pool remains. */
function applyMatch(db: Database, donationId: string, supersedesSeq: number, amountCents: number, note: string, now: number): void {
  const state = getEventState(db);
  if (state.is_match_active !== 1) return;
  const pool = foldLedger(db).derived_match_pool_cents;
  const applied = Math.min(Math.floor(amountCents * state.match_ratio), pool);
  if (applied > 0) insertMatchEvent(db, "match_apply", donationId, supersedesSeq, applied, state.match_sponsor_title || "Matching Grant", note, now);
}

function assertCardAvailable(db: Database, normalizedCard: string | null, donationId: string): void {
  if (!normalizedCard) return;
  const active = db.query<{ donation_id: string; entered_by: string | null; created_at: number; amount_cents: number; donor_name: string }, [string]>(
    `SELECT donation_id, entered_by, created_at, amount_cents, donor_name FROM active_card WHERE card_number = ?`
  ).get(normalizedCard);
  if (active && active.donation_id !== donationId) {
    throw new CardSerialCollisionError(normalizedCard, active.donation_id, active.entered_by, active.created_at, active.amount_cents, active.donor_name);
  }
}

function touchState(db: Database, now: number): void {
  db.query(`UPDATE event_state SET updated_at = ? WHERE id = 1`).run(now);
}

/**
 * Record a new donation. Idempotent on donation_id and on (source, source_txn_id),
 * so a client retrying a lost response can never create a second gift.
 */
export function recordDonation(db: Database, input: CreateDonationInput): { seq: number; donation_id: string; is_duplicate: boolean } {
  if (input.source && input.source_txn_id) {
    const existing = db.query<{ seq: number; donation_id: string }, [string, string]>(`SELECT seq, donation_id FROM ledger WHERE source = ? AND source_txn_id = ? LIMIT 1`).get(input.source, input.source_txn_id);
    if (existing) return { seq: existing.seq, donation_id: existing.donation_id, is_duplicate: true };
  }
  const existingId = db.query<{ seq: number }, [string]>(`SELECT seq FROM ledger WHERE donation_id = ? LIMIT 1`).get(input.donation_id);
  if (existingId) return { seq: existingId.seq, donation_id: input.donation_id, is_duplicate: true };

  if (!Number.isInteger(input.amount_cents) || input.amount_cents <= 0) {
    throw new Error(`Invalid donation amount: ${input.amount_cents}. Must be a positive integer in cents.`);
  }
  if (typeof input.donor_name !== "string" || !input.donor_name.trim()) throw new Error("Donor name is required.");

  const state = getEventState(db);
  if (input.amount_cents >= state.major_gift_threshold_cents && input.confirmed_major_gift !== true) {
    throw new MajorGiftConfirmationRequiredError(input.amount_cents, state.major_gift_threshold_cents);
  }
  const normalizedCard = normalizeCard(input.card_number);
  assertCardAvailable(db, normalizedCard, input.donation_id);

  const rawDonorName = input.donor_name.trim();
  const source = input.source || "manual";
  if (source === "manual" && input.confirmed_duplicate !== true) {
    const key = normalizeDonor(rawDonorName);
    const now = Date.now();
    for (const record of foldLedger(db).active_donations.values()) {
      if (record.amount_cents === input.amount_cents && now - record.created_at <= DUPLICATE_WINDOW_MS && normalizeDonor(record.donor_name) === key) {
        throw new PossibleDuplicateError(record.donation_id, record.donor_name, record.amount_cents, record.entered_by, record.created_at);
      }
    }
  }

  const isAnonymous = input.is_anonymous ? 1 : 0;
  const displayName = isAnonymous ? "Anonymous Supporter" : (input.display_name?.trim() || rawDonorName);
  const now = Date.now();
  let insertedSeq = 0;

  db.transaction(() => {
    insertedSeq = Number(db.query(INSERT_EVENT).run(
      "create", input.donation_id, null, input.amount_cents, rawDonorName, displayName, isAnonymous,
      input.payment_method || "pledge", source, input.source_txn_id || null, normalizedCard ? `#${normalizedCard}` : null,
      input.entered_by || null, input.notes?.trim() || null, input.donor_phonetic?.trim() || null, input.table_number?.trim() || null, now
    ).lastInsertRowid);
    if (normalizedCard) {
      db.query(`INSERT OR REPLACE INTO active_card (card_number, donation_id, entered_by, amount_cents, donor_name, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(normalizedCard, input.donation_id, input.entered_by || null, input.amount_cents, rawDonorName, now);
    }
    applyMatch(db, input.donation_id, insertedSeq, input.amount_cents, `Match applied for pledge ${input.donation_id}`, now);
    touchState(db, now);
  })();

  return { seq: insertedSeq, donation_id: input.donation_id, is_duplicate: false };
}

/** Amend an active donation. Matching is released and re-applied when the amount changes. */
export function amendDonation(db: Database, donationId: string, input: Partial<CreateDonationInput>): number {
  const folded = foldLedger(db);
  const existing = folded.active_donations.get(donationId);
  if (!existing) throw new Error(`Cannot amend donation ${donationId}: donation does not exist or is voided.`);

  const isAnonymous = input.is_anonymous !== undefined ? (input.is_anonymous ? 1 : 0) : (existing.is_anonymous ? 1 : 0);
  const donorName = (input.donor_name !== undefined ? input.donor_name : existing.donor_name).trim();
  if (!donorName) throw new Error("Donor name is required.");
  const displayName = isAnonymous
    ? "Anonymous Supporter"
    : (input.display_name?.trim() || (existing.display_name === "Anonymous Supporter" || input.donor_name !== undefined ? donorName : existing.display_name));
  const newAmount = input.amount_cents !== undefined ? input.amount_cents : existing.amount_cents;
  if (!Number.isInteger(newAmount) || newAmount <= 0) throw new Error(`Invalid amended amount: ${newAmount}. Must be a positive integer in cents.`);

  const state = getEventState(db);
  if (input.amount_cents !== undefined && input.amount_cents !== existing.amount_cents && input.amount_cents >= state.major_gift_threshold_cents && input.confirmed_major_gift !== true) {
    throw new MajorGiftConfirmationRequiredError(input.amount_cents, state.major_gift_threshold_cents);
  }

  const oldCard = normalizeCard(existing.card_number);
  const newCard = input.card_number !== undefined ? normalizeCard(input.card_number) : oldCard;
  if (newCard && newCard !== oldCard) assertCardAvailable(db, newCard, donationId);

  const now = Date.now();
  let insertedSeq = 0;
  db.transaction(() => {
    insertedSeq = Number(db.query(INSERT_EVENT).run(
      "amend", donationId, existing.latest_seq, newAmount, donorName, displayName, isAnonymous,
      input.payment_method || existing.payment_method, existing.source, null, newCard ? `#${newCard}` : null,
      input.entered_by || existing.entered_by,
      input.notes !== undefined ? (input.notes?.trim() || null) : existing.notes,
      input.donor_phonetic !== undefined ? (input.donor_phonetic?.trim() || null) : existing.donor_phonetic,
      input.table_number !== undefined ? (input.table_number?.trim() || null) : existing.table_number,
      now
    ).lastInsertRowid);

    if (oldCard && oldCard !== newCard) db.query(`DELETE FROM active_card WHERE card_number = ?`).run(oldCard);
    if (newCard) {
      db.query(`INSERT OR REPLACE INTO active_card (card_number, donation_id, entered_by, amount_cents, donor_name, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(newCard, donationId, input.entered_by || existing.entered_by, newAmount, donorName, now);
    }

    if (newAmount !== existing.amount_cents) {
      const existingMatch = folded.match_by_parent.get(donationId) || 0;
      if (existingMatch > 0) insertMatchEvent(db, "match_release", donationId, insertedSeq, existingMatch, "Matching Grant", `Match released on amendment for pledge ${donationId}`, now);
      applyMatch(db, donationId, insertedSeq, newAmount, `Match reapplied on amendment for pledge ${donationId}`, now);
    }
    touchState(db, now);
  })();
  return insertedSeq;
}

/** Void an active donation, freeing its card serial and releasing any applied match. */
export function voidDonation(db: Database, donationId: string, enteredBy?: string, reason?: string): number {
  const folded = foldLedger(db);
  const existing = folded.active_donations.get(donationId);
  if (!existing) throw new Error(`Cannot void donation ${donationId}: donation does not exist or is already voided.`);

  const now = Date.now();
  let insertedSeq = 0;
  db.transaction(() => {
    insertedSeq = Number(db.query(INSERT_EVENT).run(
      "void", donationId, existing.latest_seq, existing.amount_cents, existing.donor_name, existing.display_name, existing.is_anonymous ? 1 : 0,
      existing.payment_method, existing.source, null, existing.card_number, enteredBy || existing.entered_by, reason || "Voided by operator",
      existing.donor_phonetic, existing.table_number, now
    ).lastInsertRowid);
    const card = normalizeCard(existing.card_number);
    if (card) db.query(`DELETE FROM active_card WHERE card_number = ?`).run(card);
    const appliedMatch = folded.match_by_parent.get(donationId) || 0;
    if (appliedMatch > 0) insertMatchEvent(db, "match_release", donationId, insertedSeq, appliedMatch, "Matching Grant", `Match released on void of pledge ${donationId}`, now);
    touchState(db, now);
  })();
  return insertedSeq;
}

/** Restore a voided donation and re-apply matching against the remaining pool. */
export function restoreDonation(db: Database, donationId: string, enteredBy?: string, reason?: string): number {
  const folded = foldLedger(db);
  const existing = folded.all_records.get(donationId);
  if (!existing || !existing.is_voided) throw new Error(`Cannot restore donation ${donationId}: donation does not exist or is not voided.`);
  const card = normalizeCard(existing.card_number);
  assertCardAvailable(db, card, donationId);

  const now = Date.now();
  let insertedSeq = 0;
  db.transaction(() => {
    insertedSeq = Number(db.query(INSERT_EVENT).run(
      "restore", donationId, existing.latest_seq, existing.amount_cents, existing.donor_name, existing.display_name, existing.is_anonymous ? 1 : 0,
      existing.payment_method, existing.source, null, existing.card_number, enteredBy || existing.entered_by, reason || "Restored donation",
      existing.donor_phonetic, existing.table_number, now
    ).lastInsertRowid);
    if (card) {
      db.query(`INSERT OR REPLACE INTO active_card (card_number, donation_id, entered_by, amount_cents, donor_name, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(card, donationId, enteredBy || existing.entered_by, existing.amount_cents, existing.donor_name, now);
    }
    applyMatch(db, donationId, insertedSeq, existing.amount_cents, `Match applied on restore of pledge ${donationId}`, now);
    touchState(db, now);
  })();
  return insertedSeq;
}

/** Hold a donation off the stage without touching the ledger. */
export function holdDonation(db: Database, donationId: string, heldBy?: string, reason?: string): void {
  const now = Date.now();
  db.query(`INSERT OR REPLACE INTO held_donations (donation_id, held_at, held_by, reason) VALUES (?, ?, ?, ?)`).run(donationId, now, heldBy || "Operator", reason || "Held from stage");
  touchState(db, now);
}

export function releaseHeldDonation(db: Database, donationId: string): void {
  db.query(`DELETE FROM held_donations WHERE donation_id = ?`).run(donationId);
  touchState(db, Date.now());
}

export function getEventState(db: Database): EventStateRecord {
  const row = db.query<EventStateRecord, []>(`SELECT * FROM event_state WHERE id = 1`).get();
  if (!row) throw new Error("Event state record not found in database.");
  return row;
}

/** Applies a settings patch and bumps settings_seq so other sessions can detect the change. */
export function updateEventState(db: Database, patch: Partial<EventStateRecord>): EventStateRecord {
  const current = getEventState(db);
  const now = Date.now();
  const columns = EVENT_STATE_COLUMNS.filter(column => patch[column] !== undefined);
  const assignments = [...columns.map(column => `${column} = ?`), "settings_seq = ?", "updated_at = ?"].join(", ");
  const values = [...columns.map(column => patch[column] as string | number), current.settings_seq + 1, now];
  db.query(`UPDATE event_state SET ${assignments} WHERE id = 1`).run(...values);
  return getEventState(db);
}

export { getStageState, getEmceeState, getControlState, getEntryState } from "./projection";
