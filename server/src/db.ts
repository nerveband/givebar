import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

export interface DBConfig {
  dbPath?: string;
}

export function initDatabase(dbPath: string = process.env.GIVEBAR_DB_PATH || "data/givebar.sqlite"): Database {
  if (dbPath !== ":memory:") {
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
    } catch {
      // Ignore if exists
    }
  }

  const db = new Database(dbPath, { create: true });

  // Event-grade SQLite PRAGMAs
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");

  // Run schema migration
  migrateSchema(db);

  return db;
}

export function migrateSchema(db: Database): void {
  db.transaction(() => {
    // 1. Append-Only Event Ledger (Source of Truth)
    db.exec(`
      CREATE TABLE IF NOT EXISTS ledger (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,         -- 'create', 'amend', 'void', 'match_apply'
        donation_id TEXT NOT NULL,        -- UUIDv7 minted on client form open or adapter receipt
        supersedes_seq INTEGER,           -- Points to superseded record for amendments and voids
        amount_cents INTEGER NOT NULL,    -- 64-bit signed integer cents ($10,000.00 = 1000000)
        donor_name TEXT NOT NULL,         -- Full legal or CRM contact name
        display_name TEXT,                -- Sanitized public chyron text ("Dr. Alshroof" or "Anonymous Supporter")
        is_anonymous INTEGER DEFAULT 0,   -- 1 = true, 0 = false
        payment_method TEXT NOT NULL,     -- 'pledge', 'card', 'check', 'cash', 'match'
        source TEXT NOT NULL,             -- 'manual', 'bloomerang', 'kindful', 'stripe', 'qr', 'rehearsal'
        source_txn_id TEXT,               -- Vendor transaction/charge ID (Unique with source)
        card_number TEXT,                 -- Physical paper pledge card serial number (#0412)
        entered_by TEXT,                  -- Volunteer initials or adapter name
        notes TEXT,                       -- Table number, pledge terms, notes
        created_at INTEGER NOT NULL       -- Server epoch millisecond timestamp
      );
    `);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_ledger_seq ON ledger(seq);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ledger_donation_id ON ledger(donation_id);`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_source_txn ON ledger(source, source_txn_id) WHERE source_txn_id IS NOT NULL;`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ledger_card_number ON ledger(card_number) WHERE card_number IS NOT NULL;`);

    // 2. Event State & Live Configuration
    db.exec(`
      CREATE TABLE IF NOT EXISTS event_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        event_name TEXT NOT NULL DEFAULT 'Annual Gala & Benefit Auction',
        goal_cents INTEGER NOT NULL DEFAULT 50000000,          -- $500,000.00
        match_pool_cents INTEGER NOT NULL DEFAULT 0,           -- Matching pool remaining capacity
        match_total_cents INTEGER NOT NULL DEFAULT 0,          -- Total original matching fund
        match_ratio REAL NOT NULL DEFAULT 1.0,                 -- 1.0 = 1:1 match
        is_match_active INTEGER NOT NULL DEFAULT 0,            -- 0 = disabled, 1 = active on stage
        match_sponsor_title TEXT DEFAULT 'Board of Directors Matching Grant',
        is_frozen INTEGER NOT NULL DEFAULT 0,                  -- 1 = stage display frozen
        manual_override_cents INTEGER DEFAULT NULL,            -- Manual override total if emergency
        qr_donate_url TEXT DEFAULT 'https://example.org/donate?source=stage-qr',
        entry_pin TEXT NOT NULL DEFAULT '1234',
        control_pin TEXT NOT NULL DEFAULT '9999',
        milestones_json TEXT DEFAULT '[{"cents":10000000,"label":"Foundation"},{"cents":25000000,"label":"Staffing"},{"cents":50000000,"label":"Legal Clinic"},{"cents":100000000,"label":"Expansion"}]',
        odometer_floor_cents INTEGER NOT NULL DEFAULT 0,
        confetti_trigger INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);

    // Ensure default row exists
    const row = db.query(`SELECT id FROM event_state WHERE id = 1`).get();
    if (!row) {
      db.query(`
        INSERT INTO event_state (
          id, event_name, goal_cents, match_pool_cents, match_total_cents,
          match_ratio, is_match_active, match_sponsor_title, is_frozen,
          manual_override_cents, qr_donate_url, entry_pin, control_pin,
          milestones_json, odometer_floor_cents, confetti_trigger, updated_at
        ) VALUES (
          1, 'Annual Gala & Benefit Auction', 50000000, 0, 0,
          1.0, 0, 'Board of Directors Matching Grant', 0,
          NULL, 'https://example.org/donate?source=stage-qr', '1234', '9999',
          '[{"cents":10000000,"label":"Foundation"},{"cents":25000000,"label":"Staffing"},{"cents":50000000,"label":"Legal Clinic"},{"cents":100000000,"label":"Expansion"}]',
          0, 0, ?
        )
      `).run(Date.now());
    }

    // 3. Yanked Chyrons (Decoupled Display Safety Buffer)
    db.exec(`
      CREATE TABLE IF NOT EXISTS yanked_chyrons (
        donation_id TEXT PRIMARY KEY,
        yanked_at INTEGER NOT NULL,
        yanked_by TEXT,
        reason TEXT
      );
    `);

    // 4. Connector Leases & Checkpoints
    db.exec(`
      CREATE TABLE IF NOT EXISTS connector_state (
        connector_id TEXT PRIMARY KEY,
        last_cursor TEXT,
        lease_expires_at INTEGER NOT NULL DEFAULT 0,
        last_poll_at INTEGER,
        last_error TEXT
      );
    `);
  })();
}
