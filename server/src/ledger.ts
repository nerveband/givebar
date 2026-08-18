import type { Database } from "bun:sqlite";

export interface LedgerEvent {
  seq: number;
  event_type: "create" | "amend" | "void" | "match_apply";
  donation_id: string;
  supersedes_seq: number | null;
  amount_cents: number;
  donor_name: string;
  display_name: string | null;
  is_anonymous: number;
  payment_method: "pledge" | "card" | "check" | "cash" | "match";
  source: "manual" | "bloomerang" | "kindful" | "stripe" | "qr" | "rehearsal";
  source_txn_id: string | null;
  card_number: string | null;
  entered_by: string | null;
  notes: string | null;
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
  created_at: number;
  updated_at: number;
  is_voided: boolean;
}

export interface EventStateRecord {
  id: number;
  event_name: string;
  goal_cents: number;
  match_pool_cents: number;
  match_total_cents: number;
  match_ratio: number;
  is_match_active: number;
  match_sponsor_title: string;
  is_frozen: number;
  manual_override_cents: number | null;
  qr_donate_url: string;
  entry_pin: string;
  control_pin: string;
  milestones_json: string;
  odometer_floor_cents: number;
  confetti_trigger: number;
  updated_at: number;
}

export interface FoldedLedger {
  direct_raised_cents: number;
  match_applied_cents: number;
  total_raised_cents: number;
  active_donation_count: number;
  void_count: number;
  active_donations: Map<string, DonationRecord>;
  all_records: Map<string, DonationRecord>;
  latest_seq: number;
  last_event_at: number;
}

export interface CreateDonationInput {
  donation_id: string;
  amount_cents: number;
  donor_name: string;
  display_name?: string;
  is_anonymous?: boolean;
  payment_method?: "pledge" | "card" | "check" | "cash" | "match";
  source?: "manual" | "bloomerang" | "kindful" | "stripe" | "qr" | "rehearsal";
  source_txn_id?: string;
  card_number?: string;
  entered_by?: string;
  notes?: string;
}

export class CardSerialCollisionError extends Error {
  public card_number: string;
  public prior_donation_id: string;
  public prior_entered_by: string | null;
  public prior_created_at: number;

  constructor(cardNumber: string, priorDonationId: string, priorEnteredBy: string | null, priorCreatedAt: number) {
    super(`Physical pledge card #${cardNumber} was already entered by ${priorEnteredBy || "another clerk"}.`);
    this.name = "CardSerialCollisionError";
    this.card_number = cardNumber;
    this.prior_donation_id = priorDonationId;
    this.prior_entered_by = priorEnteredBy;
    this.prior_created_at = priorCreatedAt;
  }
}

/**
 * Deterministic fold over the immutable event ledger.
 */
export function foldLedger(db: Database): FoldedLedger {
  const events = db.query<LedgerEvent, []>(`SELECT * FROM ledger ORDER BY seq ASC`).all();

  const activeDonations = new Map<string, DonationRecord>();
  const allRecords = new Map<string, DonationRecord>();
  let directRaisedCents = 0;
  let matchAppliedCents = 0;
  let voidCount = 0;
  let latestSeq = 0;
  let lastEventAt = 0;

  for (const event of events) {
    latestSeq = event.seq;
    lastEventAt = event.created_at;

    if (event.event_type === "match_apply") {
      matchAppliedCents += event.amount_cents;
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
        created_at: event.created_at,
        updated_at: event.created_at,
        is_voided: false
      };
      activeDonations.set(event.donation_id, record);
      allRecords.set(event.donation_id, record);
    } else if (event.event_type === "amend") {
      const existing = activeDonations.get(event.donation_id) || allRecords.get(event.donation_id);
      if (existing && !existing.is_voided) {
        existing.latest_seq = event.seq;
        existing.amount_cents = event.amount_cents;
        existing.donor_name = event.donor_name;
        existing.display_name = event.display_name || (event.is_anonymous ? "Anonymous Supporter" : event.donor_name);
        existing.is_anonymous = Boolean(event.is_anonymous);
        existing.payment_method = event.payment_method;
        existing.card_number = event.card_number;
        existing.entered_by = event.entered_by || existing.entered_by;
        existing.notes = event.notes;
        existing.updated_at = event.created_at;
        activeDonations.set(event.donation_id, existing);
      }
    } else if (event.event_type === "void") {
      const existing = activeDonations.get(event.donation_id);
      if (existing) {
        existing.latest_seq = event.seq;
        existing.is_voided = true;
        existing.updated_at = event.created_at;
        activeDonations.delete(event.donation_id);
        voidCount++;
      }
    }
  }

  // Calculate direct raised from active donations
  for (const record of activeDonations.values()) {
    directRaisedCents += record.amount_cents;
  }

  const totalRaisedCents = directRaisedCents + matchAppliedCents;

  return {
    direct_raised_cents: directRaisedCents,
    match_applied_cents: matchAppliedCents,
    total_raised_cents: totalRaisedCents,
    active_donation_count: activeDonations.size,
    void_count: voidCount,
    active_donations: activeDonations,
    all_records: allRecords,
    latest_seq: latestSeq,
    last_event_at: lastEventAt
  };
}

/**
 * Record a new donation into the append-only ledger with idempotency,
 * collision prevention, and automatic matching grant calculation.
 */
export function recordDonation(db: Database, input: CreateDonationInput): { seq: number; donation_id: string; is_duplicate: boolean } {
  // 1. Check idempotency by source and source_txn_id
  if (input.source && input.source_txn_id) {
    const existingTxn = db.query<LedgerEvent, [string, string]>(
      `SELECT * FROM ledger WHERE source = ? AND source_txn_id = ? LIMIT 1`
    ).get(input.source, input.source_txn_id);

    if (existingTxn) {
      return { seq: existingTxn.seq, donation_id: existingTxn.donation_id, is_duplicate: true };
    }
  }

  // 2. Check idempotency by donation_id
  const existingId = db.query<LedgerEvent, [string]>(
    `SELECT * FROM ledger WHERE donation_id = ? LIMIT 1`
  ).get(input.donation_id);

  if (existingId) {
    return { seq: existingId.seq, donation_id: existingId.donation_id, is_duplicate: true };
  }

  // 3. Card serial collision check
  const normalizedCard = input.card_number ? input.card_number.trim().replace(/^#/, "") : null;
  if (normalizedCard) {
    const folded = foldLedger(db);
    for (const record of folded.active_donations.values()) {
      if (record.card_number && record.card_number.trim().replace(/^#/, "") === normalizedCard) {
        throw new CardSerialCollisionError(
          normalizedCard,
          record.donation_id,
          record.entered_by,
          record.created_at
        );
      }
    }
  }

  // 4. Sanitize public display name
  const isAnonymous = input.is_anonymous ? 1 : 0;
  const rawDonorName = input.donor_name.trim();
  const displayName = isAnonymous
    ? "Anonymous Supporter"
    : (input.display_name?.trim() || rawDonorName);

  const now = Date.now();

  let insertedSeq = 0;

  db.transaction(() => {
    const insertStmt = db.prepare(`
      INSERT INTO ledger (
        event_type, donation_id, supersedes_seq, amount_cents,
        donor_name, display_name, is_anonymous, payment_method,
        source, source_txn_id, card_number, entered_by, notes, created_at
      ) VALUES (
        'create', ?, NULL, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?
      )
    `);

    const result = insertStmt.run(
      input.donation_id,
      input.amount_cents,
      rawDonorName,
      displayName,
      isAnonymous,
      input.payment_method || "pledge",
      input.source || "manual",
      input.source_txn_id || null,
      normalizedCard ? `#${normalizedCard}` : null,
      input.entered_by || null,
      input.notes || null,
      now
    );

    insertedSeq = Number(result.lastInsertRowid);

    // 5. Handle matching grant if active
    const eventState = getEventState(db);
    if (eventState.is_match_active === 1 && eventState.match_pool_cents > 0 && input.amount_cents > 0) {
      const matchPotential = Math.floor(input.amount_cents * eventState.match_ratio);
      const matchApplied = Math.min(matchPotential, eventState.match_pool_cents);

      if (matchApplied > 0) {
        db.query(`
          INSERT INTO ledger (
            event_type, donation_id, supersedes_seq, amount_cents,
            donor_name, display_name, is_anonymous, payment_method,
            source, source_txn_id, card_number, entered_by, notes, created_at
          ) VALUES (
            'match_apply', ?, ?, ?,
            ?, ?, 0, 'match',
            'manual', NULL, NULL, 'MATCH_ENGINE', ?, ?
          )
        `).run(
          `match_${input.donation_id}`,
          insertedSeq,
          matchApplied,
          eventState.match_sponsor_title || "Matching Grant",
          eventState.match_sponsor_title || "Matching Grant",
          `Match applied for pledge ${input.donation_id}`,
          now
        );

        // Deduct from matching pool
        const remainingPool = eventState.match_pool_cents - matchApplied;
        db.query(`
          UPDATE event_state
          SET match_pool_cents = ?, updated_at = ?
          WHERE id = 1
        `).run(remainingPool, now);
      }
    }

    db.query(`UPDATE event_state SET updated_at = ? WHERE id = 1`).run(now);
  })();

  return { seq: insertedSeq, donation_id: input.donation_id, is_duplicate: false };
}

/**
 * Amend an existing donation in the ledger.
 */
export function amendDonation(db: Database, donationId: string, input: Partial<CreateDonationInput>): number {
  const folded = foldLedger(db);
  const existing = folded.active_donations.get(donationId);
  if (!existing || existing.is_voided) {
    throw new Error(`Cannot amend donation ${donationId}: donation does not exist or is voided.`);
  }

  const now = Date.now();
  const isAnonymous = input.is_anonymous !== undefined ? (input.is_anonymous ? 1 : 0) : (existing.is_anonymous ? 1 : 0);
  const donorName = (input.donor_name !== undefined ? input.donor_name : existing.donor_name).trim();
  const displayName = isAnonymous
    ? "Anonymous Supporter"
    : (input.display_name?.trim() || (input.donor_name ? donorName : existing.display_name));

  let insertedSeq = 0;

  db.transaction(() => {
    const result = db.query(`
      INSERT INTO ledger (
        event_type, donation_id, supersedes_seq, amount_cents,
        donor_name, display_name, is_anonymous, payment_method,
        source, source_txn_id, card_number, entered_by, notes, created_at
      ) VALUES (
        'amend', ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?
      )
    `).run(
      donationId,
      existing.latest_seq,
      input.amount_cents !== undefined ? input.amount_cents : existing.amount_cents,
      donorName,
      displayName,
      isAnonymous,
      input.payment_method || existing.payment_method,
      existing.source,
      existing.card_number,
      input.card_number ? input.card_number.trim() : existing.card_number,
      input.entered_by || existing.entered_by,
      input.notes !== undefined ? input.notes : existing.notes,
      now
    );

    insertedSeq = Number(result.lastInsertRowid);
    db.query(`UPDATE event_state SET updated_at = ? WHERE id = 1`).run(now);
  })();

  return insertedSeq;
}

/**
 * Void a donation in the ledger.
 */
export function voidDonation(db: Database, donationId: string, enteredBy?: string, reason?: string): number {
  const folded = foldLedger(db);
  const existing = folded.active_donations.get(donationId);
  if (!existing || existing.is_voided) {
    throw new Error(`Cannot void donation ${donationId}: donation does not exist or is already voided.`);
  }

  const now = Date.now();
  let insertedSeq = 0;

  db.transaction(() => {
    const result = db.query(`
      INSERT INTO ledger (
        event_type, donation_id, supersedes_seq, amount_cents,
        donor_name, display_name, is_anonymous, payment_method,
        source, source_txn_id, card_number, entered_by, notes, created_at
      ) VALUES (
        'void', ?, ?, 0,
        ?, ?, ?, ?,
        ?, NULL, ?, ?, ?, ?
      )
    `).run(
      donationId,
      existing.latest_seq,
      existing.donor_name,
      existing.display_name,
      existing.is_anonymous ? 1 : 0,
      existing.payment_method,
      existing.source,
      existing.card_number,
      enteredBy || existing.entered_by,
      reason || "Voided by user",
      now
    );

    insertedSeq = Number(result.lastInsertRowid);

    // Also auto-yank from stage chyrons
    db.query(`
      INSERT OR REPLACE INTO yanked_chyrons (donation_id, yanked_at, yanked_by, reason)
      VALUES (?, ?, ?, ?)
    `).run(donationId, now, enteredBy || "SYSTEM", "Donation voided");

    db.query(`UPDATE event_state SET updated_at = ? WHERE id = 1`).run(now);
  })();

  return insertedSeq;
}

/**
 * Yank a donation chyron from appearing on the stage HUD.
 */
export function yankChyron(db: Database, donationId: string, yankedBy?: string, reason?: string): void {
  const now = Date.now();
  db.query(`
    INSERT OR REPLACE INTO yanked_chyrons (donation_id, yanked_at, yanked_by, reason)
    VALUES (?, ?, ?, ?)
  `).run(donationId, now, yankedBy || "ADMIN", reason || "Yanked by AV Director");

  db.query(`UPDATE event_state SET updated_at = ? WHERE id = 1`).run(now);
}

/**
 * Un-yank a donation chyron.
 */
export function unyankChyron(db: Database, donationId: string): void {
  db.query(`DELETE FROM yanked_chyrons WHERE donation_id = ?`).run(donationId);
  db.query(`UPDATE event_state SET updated_at = ? WHERE id = 1`).run(Date.now());
}

/**
 * Fetch current Event State configuration.
 */
export function getEventState(db: Database): EventStateRecord {
  const state = db.query<EventStateRecord, []>(`SELECT * FROM event_state WHERE id = 1`).get();
  if (!state) {
    throw new Error("event_state row missing. Run migrations.");
  }
  return state;
}

/**
 * Update event configuration.
 */
export function updateEventState(db: Database, updates: Partial<EventStateRecord>): EventStateRecord {
  const current = getEventState(db);
  const now = Date.now();

  const next = {
    ...current,
    ...updates,
    updated_at: now
  };

  db.query(`
    UPDATE event_state SET
      event_name = ?,
      goal_cents = ?,
      match_pool_cents = ?,
      match_total_cents = ?,
      match_ratio = ?,
      is_match_active = ?,
      match_sponsor_title = ?,
      is_frozen = ?,
      manual_override_cents = ?,
      qr_donate_url = ?,
      entry_pin = ?,
      control_pin = ?,
      milestones_json = ?,
      odometer_floor_cents = ?,
      confetti_trigger = ?,
      updated_at = ?
    WHERE id = 1
  `).run(
    next.event_name,
    next.goal_cents,
    next.match_pool_cents,
    next.match_total_cents,
    next.match_ratio,
    next.is_match_active,
    next.match_sponsor_title,
    next.is_frozen,
    next.manual_override_cents,
    next.qr_donate_url,
    next.entry_pin,
    next.control_pin,
    next.milestones_json,
    next.odometer_floor_cents,
    next.confetti_trigger,
    now
  );

  return next;
}

/**
 * Stage HUD state projection (/stage)
 * - Strips all real donor names for anonymous gifts (Strict Privacy Shield).
 * - Applies 8-second delay buffer for chyrons.
 * - Filters out yanked chyrons.
 * - Supports no-backward-odometer tracking.
 */
export function getStageState(db: Database, sinceSeq: number = 0) {
  const eventState = getEventState(db);
  const folded = foldLedger(db);
  const now = Date.now();

  // Determine effective total
  const trueTotal = folded.total_raised_cents;
  const effectiveTotal = eventState.manual_override_cents !== null && eventState.manual_override_cents !== undefined
    ? eventState.manual_override_cents
    : trueTotal;

  // No-backward-odometer floor check: if total went below floor, keep floor unless manually resynced
  const displayTotal = Math.max(effectiveTotal, eventState.odometer_floor_cents);

  // Update odometer floor if new total is higher
  if (displayTotal > eventState.odometer_floor_cents && !eventState.is_frozen) {
    db.query(`UPDATE event_state SET odometer_floor_cents = ? WHERE id = 1`).run(displayTotal);
  }

  // Parse milestones
  let milestones: Array<{ cents: number; label: string }> = [];
  try {
    milestones = JSON.parse(eventState.milestones_json);
  } catch {
    milestones = [
      { cents: 10000000, label: "Foundation" },
      { cents: 25000000, label: "Staffing" },
      { cents: 50000000, label: "Legal Clinic" },
      { cents: 100000000, label: "Expansion" }
    ];
  }

  // Fetch yanked set
  const yankedRows = db.query<{ donation_id: string }, []>(`SELECT donation_id FROM yanked_chyrons`).all();
  const yankedSet = new Set(yankedRows.map(r => r.donation_id));

  // Build chyron stream: delayed by 8 seconds, not yanked, anonymized
  const chyronBufferMs = 8000;
  const chyrons: Array<{
    donation_id: string;
    display_name: string;
    amount_cents: number;
    created_at: number;
  }> = [];

  // Sort active donations by created_at DESC
  const sortedDonations = Array.from(folded.active_donations.values())
    .filter(d => !d.is_voided && !yankedSet.has(d.donation_id))
    .sort((a, b) => b.created_at - a.created_at);

  for (const d of sortedDonations) {
    // Only include if past the 8-second delay buffer
    if (now - d.created_at >= chyronBufferMs) {
      chyrons.push({
        donation_id: d.donation_id,
        display_name: d.is_anonymous ? "Anonymous Supporter" : d.display_name,
        amount_cents: d.amount_cents,
        created_at: d.created_at
      });
    }
  }

  const percent = eventState.goal_cents > 0
    ? Math.min(100, Math.round((displayTotal / eventState.goal_cents) * 1000) / 10)
    : 0;

  return {
    seq: folded.latest_seq,
    event_name: eventState.event_name,
    total_raised_cents: displayTotal,
    true_total_raised_cents: trueTotal,
    goal_cents: eventState.goal_cents,
    percent,
    is_match_active: Boolean(eventState.is_match_active),
    match_sponsor_title: eventState.match_sponsor_title,
    match_pool_cents: eventState.match_pool_cents,
    match_total_cents: eventState.match_total_cents,
    is_frozen: Boolean(eventState.is_frozen),
    qr_donate_url: eventState.qr_donate_url,
    milestones,
    chyrons: chyrons.slice(0, 30), // Latest 30 verified chyrons
    confetti_trigger: eventState.confetti_trigger,
    server_time: now
  };
}

/**
 * Emcee Confidence Monitor state projection (/emcee)
 */
export function getEmceeState(db: Database) {
  const eventState = getEventState(db);
  const folded = foldLedger(db);
  const now = Date.now();

  const totalRaised = eventState.manual_override_cents !== null ? eventState.manual_override_cents : folded.total_raised_cents;

  // Parse milestones and find next milestone distance
  let milestones: Array<{ cents: number; label: string }> = [];
  try {
    milestones = JSON.parse(eventState.milestones_json);
  } catch {
    milestones = [];
  }

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

  // Top 5 largest gifts for shoutouts
  const topGifts = Array.from(folded.active_donations.values())
    .sort((a, b) => b.amount_cents - a.amount_cents)
    .slice(0, 5)
    .map(d => ({
      donation_id: d.donation_id,
      display_name: d.is_anonymous ? "Anonymous Supporter" : d.donor_name,
      amount_cents: d.amount_cents,
      is_anonymous: d.is_anonymous,
      notes: d.notes,
      entered_by: d.entered_by
    }));

  // Recent 10 gifts
  const recentGifts = Array.from(folded.active_donations.values())
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 10)
    .map(d => ({
      donation_id: d.donation_id,
      display_name: d.is_anonymous ? "Anonymous Supporter" : d.donor_name,
      amount_cents: d.amount_cents,
      is_anonymous: d.is_anonymous,
      notes: d.notes,
      created_at: d.created_at,
      seconds_ago: Math.max(0, Math.floor((now - d.created_at) / 1000))
    }));

  const percent = eventState.goal_cents > 0
    ? Math.min(100, Math.round((totalRaised / eventState.goal_cents) * 1000) / 10)
    : 0;

  return {
    seq: folded.latest_seq,
    event_name: eventState.event_name,
    total_raised_cents: totalRaised,
    direct_raised_cents: folded.direct_raised_cents,
    match_applied_cents: folded.match_applied_cents,
    goal_cents: eventState.goal_cents,
    percent,
    active_donation_count: folded.active_donation_count,
    next_milestone: nextMilestone,
    is_match_active: Boolean(eventState.is_match_active),
    match_pool_cents: eventState.match_pool_cents,
    match_total_cents: eventState.match_total_cents,
    match_sponsor_title: eventState.match_sponsor_title,
    top_gifts: topGifts,
    recent_gifts: recentGifts,
    is_frozen: Boolean(eventState.is_frozen),
    server_time: now
  };
}

/**
 * AV & Admin Control Deck state projection (/control)
 */
export function getControlState(db: Database) {
  const eventState = getEventState(db);
  const folded = foldLedger(db);
  const now = Date.now();

  const yankedRows = db.query<{ donation_id: string; yanked_at: number; yanked_by: string; reason: string }, []>(
    `SELECT * FROM yanked_chyrons`
  ).all();
  const yankedMap = new Map(yankedRows.map(r => [r.donation_id, r]));

  // Staging Buffer: All active donations from the last 60 seconds
  const chyronBufferMs = 8000;
  const stagedChyrons = Array.from(folded.active_donations.values())
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 40)
    .map(d => {
      const elapsedMs = now - d.created_at;
      const isLiveOnStage = elapsedMs >= chyronBufferMs;
      const remainingDelaySec = isLiveOnStage ? 0 : Math.ceil((chyronBufferMs - elapsedMs) / 1000);
      const yankInfo = yankedMap.get(d.donation_id);

      return {
        donation_id: d.donation_id,
        donor_name: d.donor_name,
        display_name: d.display_name,
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
        is_yanked: Boolean(yankInfo),
        yank_info: yankInfo || null
      };
    });

  // Recent 50 raw ledger events for audit log
  const recentEvents = db.query<LedgerEvent, []>(
    `SELECT * FROM ledger ORDER BY seq DESC LIMIT 50`
  ).all();

  return {
    seq: folded.latest_seq,
    event_state: eventState,
    folded: {
      total_raised_cents: folded.total_raised_cents,
      direct_raised_cents: folded.direct_raised_cents,
      match_applied_cents: folded.match_applied_cents,
      active_donation_count: folded.active_donation_count,
      void_count: folded.void_count
    },
    staged_chyrons: stagedChyrons,
    recent_events: recentEvents,
    server_time: now
  };
}

/**
 * Volunteer Entry Terminal state projection (/entry)
 */
export function getVolunteerState(db: Database, volunteerId?: string) {
  const eventState = getEventState(db);
  const folded = foldLedger(db);
  const now = Date.now();

  // Get volunteer's personal audit log (last 15 submissions)
  let personalLog: DonationRecord[] = [];
  if (volunteerId) {
    personalLog = Array.from(folded.all_records.values())
      .filter(d => d.entered_by === volunteerId)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 15);
  }

  return {
    seq: folded.latest_seq,
    event_name: eventState.event_name,
    total_raised_cents: eventState.manual_override_cents !== null ? eventState.manual_override_cents : folded.total_raised_cents,
    goal_cents: eventState.goal_cents,
    personal_log: personalLog,
    server_time: now
  };
}
