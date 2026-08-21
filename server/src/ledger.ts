import type { Database } from "bun:sqlite";

export interface LedgerEvent {
  seq: number;
  event_type: "create" | "amend" | "void" | "match_apply" | "match_release";
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
  donor_phonetic?: string | null;
  table_number?: string | null;
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
  donor_phonetic?: string | null;
  table_number?: string | null;
  created_at: number;
  updated_at: number;
  is_voided: boolean;
  matched_amount_cents: number;
}

export interface EventStateRecord {
  id: number;
  event_name: string;
  event_subtitle: string;
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
  theme_preset: string;
  brand_hue: number;
  brand_chroma: number;
  brand_accent_hex: string;
  brand_radius_px: number;
  major_gift_threshold_cents: number;
  stage_delay_ms: number;
  confetti_on_milestone: number;
  settings_seq: number;
  updated_at: number;
}

export interface FoldOptions {
  maxCreatedAt?: number;
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
  payment_method?: "pledge" | "card" | "check" | "cash" | "match";
  source?: "manual" | "bloomerang" | "kindful" | "stripe" | "qr" | "rehearsal";
  source_txn_id?: string;
  card_number?: string;
  entered_by?: string;
  notes?: string;
  donor_phonetic?: string;
  table_number?: string;
}

export class CardSerialCollisionError extends Error {
  public card_number: string;
  public prior_donation_id: string;
  public prior_entered_by: string | null;
  public prior_created_at: number;
  public prior_amount_cents: number;
  public prior_donor_name: string;

  constructor(
    cardNumber: string,
    priorDonationId: string,
    priorEnteredBy: string | null,
    priorCreatedAt: number,
    priorAmountCents: number = 0,
    priorDonorName: string = ""
  ) {
    super(`Physical pledge card #${cardNumber} was already entered by ${priorEnteredBy || "another volunteer"}.`);
    this.name = "CardSerialCollisionError";
    this.card_number = cardNumber;
    this.prior_donation_id = priorDonationId;
    this.prior_entered_by = priorEnteredBy;
    this.prior_created_at = priorCreatedAt;
    this.prior_amount_cents = priorAmountCents;
    this.prior_donor_name = priorDonorName;
  }
}

export function normalizeCard(card?: string | null): string | null {
  if (!card) return null;
  const trimmed = card.trim().replace(/^#/, "").toUpperCase();
  return trimmed === "" ? null : trimmed;
}

/**
 * Deterministic fold over the immutable event ledger.
 * Pure function: supports time horizons and exclusions for delayed projections.
 */
export function foldLedger(db: Database, options?: FoldOptions): FoldedLedger {
  const events = db.query<LedgerEvent, []>(`SELECT * FROM ledger ORDER BY seq ASC`).all();
  const eventState = getEventState(db);

  const activeDonations = new Map<string, DonationRecord>();
  const allRecords = new Map<string, DonationRecord>();
  const matchByParent = new Map<string, number>();

  let directRaisedCents = 0;
  let matchAppliedCents = 0;
  let voidCount = 0;
  let latestSeq = 0;
  let lastEventAt = 0;

  for (const event of events) {
    // Respect time horizon if specified
    if (options?.maxCreatedAt && event.created_at > options.maxCreatedAt) {
      continue;
    }

    latestSeq = event.seq;
    lastEventAt = event.created_at;

    // 1. Matching Events (Apply / Release)
    if (event.event_type === "match_apply") {
      const parentId = event.donation_id.replace(/^match_/, "");
      // Skip match if parent is excluded
      if (options?.excludeDonationIds?.has(parentId)) {
        continue;
      }
      matchAppliedCents += event.amount_cents;
      matchByParent.set(parentId, (matchByParent.get(parentId) || 0) + event.amount_cents);
      continue;
    }

    if (event.event_type === "match_release") {
      const parentId = event.donation_id.replace(/^match_/, "");
      if (options?.excludeDonationIds?.has(parentId)) {
        continue;
      }
      matchAppliedCents = Math.max(0, matchAppliedCents - event.amount_cents);
      const currentParentMatch = matchByParent.get(parentId) || 0;
      const updatedParentMatch = Math.max(0, currentParentMatch - event.amount_cents);
      if (updatedParentMatch === 0) {
        matchByParent.delete(parentId);
      } else {
        matchByParent.set(parentId, updatedParentMatch);
      }
      continue;
    }

    // Skip donation if explicitly excluded
    if (options?.excludeDonationIds?.has(event.donation_id)) {
      continue;
    }

    // 2. Core Donation Events
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
        existing.donor_phonetic = event.donor_phonetic ?? existing.donor_phonetic;
        existing.table_number = event.table_number ?? existing.table_number;
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

  // Calculate direct raised from active donations and attach matched amounts
  for (const record of activeDonations.values()) {
    directRaisedCents += record.amount_cents;
    record.matched_amount_cents = matchByParent.get(record.donation_id) || 0;
  }

  // Pure derived remaining matching pool
  const derivedPoolRemaining = Math.max(0, eventState.match_total_cents - matchAppliedCents);
  const totalRaisedCents = directRaisedCents + matchAppliedCents;

  return {
    direct_raised_cents: directRaisedCents,
    match_applied_cents: matchAppliedCents,
    derived_match_pool_cents: derivedPoolRemaining,
    total_raised_cents: totalRaisedCents,
    active_donation_count: activeDonations.size,
    void_count: voidCount,
    active_donations: activeDonations,
    all_records: allRecords,
    match_by_parent: matchByParent,
    latest_seq: latestSeq,
    last_event_at: lastEventAt
  };
}

/**
 * Record a new donation into the append-only ledger with idempotency,
 * O(1) active card collision prevention, and automatic matching grant calculation.
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

  // Check idempotency by donation_id
  const existingId = db.query<LedgerEvent, [string]>(
    `SELECT * FROM ledger WHERE donation_id = ? LIMIT 1`
  ).get(input.donation_id);

  if (existingId) {
    return { seq: existingId.seq, donation_id: existingId.donation_id, is_duplicate: true };
  }

  // 2. Validate amount
  if (input.amount_cents <= 0) {
    throw new Error(`Invalid donation amount: ${input.amount_cents}. Must be greater than 0.`);
  }

  // 3. O(1) Physical Card Collision Detection
  const normalizedCard = normalizeCard(input.card_number);
  if (normalizedCard) {
    const activeCard = db.query<{ card_number: string; donation_id: string; entered_by: string; created_at: number; amount_cents: number; donor_name: string }, [string]>(
      `SELECT * FROM active_card WHERE card_number = ? LIMIT 1`
    ).get(normalizedCard);

    if (activeCard && activeCard.donation_id !== input.donation_id) {
      throw new CardSerialCollisionError(
        normalizedCard,
        activeCard.donation_id,
        activeCard.entered_by,
        activeCard.created_at,
        activeCard.amount_cents,
        activeCard.donor_name
      );
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
        source, source_txn_id, card_number, entered_by, notes,
        donor_phonetic, table_number, created_at
      ) VALUES (
        'create', ?, NULL, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?
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
      input.donor_phonetic || null,
      input.table_number || null,
      now
    );

    insertedSeq = Number(result.lastInsertRowid);

    // Register active card in lookup table
    if (normalizedCard) {
      db.query(`
        INSERT OR REPLACE INTO active_card (card_number, donation_id, entered_by, amount_cents, donor_name, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(normalizedCard, input.donation_id, input.entered_by || null, input.amount_cents, rawDonorName, now);
    }

    // 5. Handle matching grant if active (Pure fold calculation)
    const eventState = getEventState(db);
    const folded = foldLedger(db);

    if (eventState.is_match_active === 1 && folded.derived_match_pool_cents > 0 && input.amount_cents > 0) {
      const matchPotential = Math.floor(input.amount_cents * eventState.match_ratio);
      const matchApplied = Math.min(matchPotential, folded.derived_match_pool_cents);

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
      }
    }

    // Advance odometer floor if total increased and display is not frozen
    const updatedFold = foldLedger(db);
    if (updatedFold.total_raised_cents > eventState.odometer_floor_cents && !eventState.is_frozen) {
      db.query(`UPDATE event_state SET odometer_floor_cents = ?, updated_at = ? WHERE id = 1`).run(updatedFold.total_raised_cents, now);
    } else {
      db.query(`UPDATE event_state SET updated_at = ? WHERE id = 1`).run(now);
    }
  })();

  return { seq: insertedSeq, donation_id: input.donation_id, is_duplicate: false };
}

/**
 * Amend an existing donation in the ledger.
 * Recomputes matching grants and updates active card table.
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

  const newAmount = input.amount_cents !== undefined ? input.amount_cents : existing.amount_cents;
  const newNormalizedCard = input.card_number !== undefined ? normalizeCard(input.card_number) : normalizeCard(existing.card_number);

  // Check card collision if card number changed
  if (newNormalizedCard && newNormalizedCard !== normalizeCard(existing.card_number)) {
    const activeCard = db.query<{ card_number: string; donation_id: string; entered_by: string; created_at: number; amount_cents: number; donor_name: string }, [string]>(
      `SELECT * FROM active_card WHERE card_number = ? LIMIT 1`
    ).get(newNormalizedCard);

    if (activeCard && activeCard.donation_id !== donationId) {
      throw new CardSerialCollisionError(
        newNormalizedCard,
        activeCard.donation_id,
        activeCard.entered_by,
        activeCard.created_at,
        activeCard.amount_cents,
        activeCard.donor_name
      );
    }
  }

  let insertedSeq = 0;

  db.transaction(() => {
    // 1. Insert amend event (Correct argument ordering!)
    const result = db.query(`
      INSERT INTO ledger (
        event_type, donation_id, supersedes_seq, amount_cents,
        donor_name, display_name, is_anonymous, payment_method,
        source, source_txn_id, card_number, entered_by, notes,
        donor_phonetic, table_number, created_at
      ) VALUES (
        'amend', ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?
      )
    `).run(
      donationId,
      existing.latest_seq,
      newAmount,
      donorName,
      displayName,
      isAnonymous,
      input.payment_method || existing.payment_method,
      existing.source,
      null, // source_txn_id is null for manual amendments
      newNormalizedCard ? `#${newNormalizedCard}` : null,
      input.entered_by || existing.entered_by,
      input.notes !== undefined ? input.notes : existing.notes,
      input.donor_phonetic !== undefined ? input.donor_phonetic : existing.donor_phonetic || null,
      input.table_number !== undefined ? input.table_number : existing.table_number || null,
      now
    );

    insertedSeq = Number(result.lastInsertRowid);

    // 2. Update active card index
    const oldNormalizedCard = normalizeCard(existing.card_number);
    if (oldNormalizedCard && oldNormalizedCard !== newNormalizedCard) {
      db.query(`DELETE FROM active_card WHERE card_number = ?`).run(oldNormalizedCard);
    }
    if (newNormalizedCard) {
      db.query(`
        INSERT OR REPLACE INTO active_card (card_number, donation_id, entered_by, amount_cents, donor_name, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(newNormalizedCard, donationId, input.entered_by || existing.entered_by, newAmount, donorName, now);
    }

    // 3. Recalculate matching grant (Release old match and apply new match)
    const existingMatch = folded.match_by_parent.get(donationId) || 0;
    if (existingMatch > 0) {
      db.query(`
        INSERT INTO ledger (
          event_type, donation_id, supersedes_seq, amount_cents,
          donor_name, display_name, is_anonymous, payment_method,
          source, source_txn_id, card_number, entered_by, notes, created_at
        ) VALUES (
          'match_release', ?, ?, ?,
          'Matching Grant', 'Matching Grant', 0, 'match',
          'manual', NULL, NULL, 'MATCH_ENGINE', ?, ?
        )
      `).run(
        `match_${donationId}`,
        insertedSeq,
        existingMatch,
        `Match released on amendment for pledge ${donationId}`,
        now
      );
    }

    const eventState = getEventState(db);
    const refreshedFold = foldLedger(db);
    if (eventState.is_match_active === 1 && refreshedFold.derived_match_pool_cents > 0 && newAmount > 0) {
      const matchPotential = Math.floor(newAmount * eventState.match_ratio);
      const matchApplied = Math.min(matchPotential, refreshedFold.derived_match_pool_cents);

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
          `match_${donationId}`,
          insertedSeq,
          matchApplied,
          eventState.match_sponsor_title || "Matching Grant",
          eventState.match_sponsor_title || "Matching Grant",
          `Match reapplied on amendment for pledge ${donationId}`,
          now
        );
      }
    }

    // Advance floor if total increased
    const postAmendFold = foldLedger(db);
    if (postAmendFold.total_raised_cents > eventState.odometer_floor_cents && !eventState.is_frozen) {
      db.query(`UPDATE event_state SET odometer_floor_cents = ?, updated_at = ? WHERE id = 1`).run(postAmendFold.total_raised_cents, now);
    } else {
      db.query(`UPDATE event_state SET updated_at = ? WHERE id = 1`).run(now);
    }
  })();

  return insertedSeq;
}

/**
 * Void a donation in the ledger.
 * Emits compensating match_release event and frees up active card serial.
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
        'void', ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?
      )
    `).run(
      donationId,
      existing.latest_seq,
      existing.amount_cents,
      existing.donor_name,
      existing.display_name,
      existing.is_anonymous ? 1 : 0,
      existing.payment_method,
      existing.source,
      null,
      existing.card_number,
      enteredBy || existing.entered_by,
      reason || "Voided by operator",
      now
    );

    insertedSeq = Number(result.lastInsertRowid);

    // Free up active card so it can be reused
    const normalizedCard = normalizeCard(existing.card_number);
    if (normalizedCard) {
      db.query(`DELETE FROM active_card WHERE card_number = ?`).run(normalizedCard);
    }

    // Release matching grant if any was applied
    const appliedMatch = folded.match_by_parent.get(donationId) || 0;
    if (appliedMatch > 0) {
      db.query(`
        INSERT INTO ledger (
          event_type, donation_id, supersedes_seq, amount_cents,
          donor_name, display_name, is_anonymous, payment_method,
          source, source_txn_id, card_number, entered_by, notes, created_at
        ) VALUES (
          'match_release', ?, ?, ?,
          'Matching Grant', 'Matching Grant', 0, 'match',
          'manual', NULL, NULL, 'MATCH_ENGINE', ?, ?
        )
      `).run(
        `match_${donationId}`,
        insertedSeq,
        appliedMatch,
        `Match released on void of pledge ${donationId}`,
        now
      );
    }

    db.query(`UPDATE event_state SET updated_at = ? WHERE id = 1`).run(now);
  })();

  return insertedSeq;
}

/**
 * Hold a donation from stage projection (1-click hold).
 */
export function holdDonation(db: Database, donationId: string, heldBy?: string, reason?: string): void {
  const now = Date.now();
  db.query(`
    INSERT OR REPLACE INTO held_donations (donation_id, held_at, held_by, reason)
    VALUES (?, ?, ?, ?)
  `).run(donationId, now, heldBy || "AV Director", reason || "Held from stage");
  db.query(`UPDATE event_state SET updated_at = ? WHERE id = 1`).run(now);
}

/**
 * Release a held donation back onto the stage.
 */
export function releaseHeldDonation(db: Database, donationId: string): void {
  db.query(`DELETE FROM held_donations WHERE donation_id = ?`).run(donationId);
  db.query(`UPDATE event_state SET updated_at = ? WHERE id = 1`).run(Date.now());
}

/**
 * Get current event state with derived match pool.
 */
export function getEventState(db: Database): EventStateRecord {
  const row = db.query<EventStateRecord, []>(`SELECT * FROM event_state WHERE id = 1`).get();
  if (!row) {
    throw new Error("Event state record not found in database.");
  }

  // Derive remaining matching pool from the ledger
  const matchRow = db.query<{ total_applied: number; total_released: number }, []>(`
    SELECT 
      COALESCE(SUM(CASE WHEN event_type = 'match_apply' THEN amount_cents ELSE 0 END), 0) as total_applied,
      COALESCE(SUM(CASE WHEN event_type = 'match_release' THEN amount_cents ELSE 0 END), 0) as total_released
    FROM ledger
  `).get();
  const netMatch = matchRow ? Math.max(0, matchRow.total_applied - matchRow.total_released) : 0;
  row.match_pool_cents = Math.max(0, row.match_total_cents - netMatch);

  return row;
}

/**
 * Update event state settings.
 */
export function updateEventState(db: Database, patch: Partial<EventStateRecord>): EventStateRecord {
  const current = getEventState(db);
  const now = Date.now();
  const nextSeq = (current.settings_seq || 1) + 1;

  const updated: EventStateRecord = {
    ...current,
    ...patch,
    settings_seq: nextSeq,
    updated_at: now
  };

  db.query(`
    UPDATE event_state
    SET event_name = ?,
        event_subtitle = ?,
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
        theme_preset = ?,
        brand_hue = ?,
        brand_chroma = ?,
        brand_accent_hex = ?,
        brand_radius_px = ?,
        major_gift_threshold_cents = ?,
        stage_delay_ms = ?,
        confetti_on_milestone = ?,
        settings_seq = ?,
        updated_at = ?
    WHERE id = 1
  `).run(
    updated.event_name,
    updated.event_subtitle,
    updated.goal_cents,
    updated.match_pool_cents,
    updated.match_total_cents,
    updated.match_ratio,
    updated.is_match_active,
    updated.match_sponsor_title,
    updated.is_frozen,
    updated.manual_override_cents,
    updated.qr_donate_url,
    updated.entry_pin,
    updated.control_pin,
    updated.milestones_json,
    updated.odometer_floor_cents,
    updated.confetti_trigger,
    updated.theme_preset,
    updated.brand_hue,
    updated.brand_chroma,
    updated.brand_accent_hex,
    updated.brand_radius_px,
    updated.major_gift_threshold_cents,
    updated.stage_delay_ms,
    updated.confetti_on_milestone,
    updated.settings_seq,
    now
  );

  return updated;
}

// Re-export projections and backwards compatibility aliases
export const yankChyron = holdDonation;
export const unyankChyron = releaseHeldDonation;
export { getStageState, getEmceeState, getControlState, getVolunteerState } from "./projection";
