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
      // Ignore if directory already exists
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
        event_type TEXT NOT NULL,         -- 'create', 'amend', 'void', 'match_apply', 'match_release'
        donation_id TEXT NOT NULL,        -- UUID minted on client form open or adapter receipt
        supersedes_seq INTEGER,           -- Points to superseded record for amendments and voids
        amount_cents INTEGER NOT NULL,    -- 64-bit signed integer cents ($10,000.00 = 1000000)
        donor_name TEXT NOT NULL,         -- Full legal or CRM contact name
        display_name TEXT,                -- Sanitized public chyron text ("Dr. Arthur" or "Anonymous Supporter")
        is_anonymous INTEGER DEFAULT 0,   -- 1 = true, 0 = false
        payment_method TEXT NOT NULL,     -- 'pledge', 'card', 'check', 'cash', 'match'
        source TEXT NOT NULL,             -- 'manual', 'bloomerang', 'kindful', 'stripe', 'qr', 'rehearsal'
        source_txn_id TEXT,               -- Vendor transaction/charge ID (Unique with source)
        card_number TEXT,                 -- Physical paper pledge card serial number (0412)
        entered_by TEXT,                  -- Volunteer initials or adapter name
        notes TEXT,                       -- Table number, pledge terms, notes
        donor_phonetic TEXT,              -- Podium pronunciation guide
        table_number TEXT,                -- Table number for vocal shoutouts
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
        event_subtitle TEXT NOT NULL DEFAULT 'Supporting Community Programs & Education',
        goal_cents INTEGER NOT NULL DEFAULT 50000000,          -- $500,000.00
        match_pool_cents INTEGER NOT NULL DEFAULT 0,           -- Historical field, derived dynamically
        match_total_cents INTEGER NOT NULL DEFAULT 0,          -- Total original matching fund
        match_ratio REAL NOT NULL DEFAULT 1.0,                 -- 1.0 = 1:1 match
        is_match_active INTEGER NOT NULL DEFAULT 0,            -- 0 = disabled, 1 = active on stage
        match_sponsor_title TEXT DEFAULT 'Board of Directors Matching Grant',
        is_frozen INTEGER NOT NULL DEFAULT 0,                  -- 1 = stage display frozen
        manual_override_cents INTEGER DEFAULT NULL,            -- Manual override total if emergency
        qr_donate_url TEXT DEFAULT 'https://give.hope.org/donate',
        qr_style TEXT NOT NULL DEFAULT 'dots',                 -- 'dots', 'squircle', 'squares'
        qr_center_icon TEXT NOT NULL DEFAULT 'star',           -- 'star', 'heart', 'gift', 'sparkle', 'none'
        qr_fg_color TEXT NOT NULL DEFAULT '',                  -- Empty means adapt to theme
        qr_bg_color TEXT NOT NULL DEFAULT '#FFFFFF',
        entry_pin TEXT NOT NULL DEFAULT '1234',
        control_pin TEXT NOT NULL DEFAULT '9999',
        milestones_json TEXT DEFAULT '[{"cents":10000000,"label":"Foundation"},{"cents":25000000,"label":"Staffing"},{"cents":50000000,"label":"Legal Clinic"},{"cents":100000000,"label":"Expansion"}]',
        odometer_floor_cents INTEGER NOT NULL DEFAULT 0,
        confetti_trigger INTEGER NOT NULL DEFAULT 0,
        theme_preset TEXT NOT NULL DEFAULT 'champagne',
        brand_hue REAL NOT NULL DEFAULT 85,
        brand_chroma REAL NOT NULL DEFAULT 0.12,
        brand_accent_hex TEXT NOT NULL DEFAULT '',
        brand_radius_px INTEGER NOT NULL DEFAULT 12,
        major_gift_threshold_cents INTEGER NOT NULL DEFAULT 950000,
        stage_delay_ms INTEGER NOT NULL DEFAULT 8000,
        confetti_on_milestone INTEGER NOT NULL DEFAULT 1,
        countdown_seconds INTEGER NOT NULL DEFAULT 300,
        timer_status TEXT NOT NULL DEFAULT 'stopped',
        timer_ends_at INTEGER DEFAULT NULL,
        thermometer_visual_mode TEXT NOT NULL DEFAULT 'classic',
        embed_media_url TEXT DEFAULT '',
        trust_badge_text TEXT NOT NULL DEFAULT '501(c)(3) Tax-Deductible Contribution',
        pinned_donation_id TEXT DEFAULT NULL,
        settings_seq INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );
    `);

    // Ensure default state row exists
    const row = db.query(`SELECT id FROM event_state WHERE id = 1`).get();
    if (!row) {
      db.query(`
        INSERT INTO event_state (
          id, event_name, event_subtitle, goal_cents, match_pool_cents, match_total_cents,
          match_ratio, is_match_active, match_sponsor_title, is_frozen,
          manual_override_cents, qr_donate_url, qr_style, qr_center_icon, qr_fg_color, qr_bg_color,
          entry_pin, control_pin, milestones_json, odometer_floor_cents, confetti_trigger,
          theme_preset, brand_hue, brand_chroma, brand_accent_hex, brand_radius_px,
          major_gift_threshold_cents, stage_delay_ms, confetti_on_milestone,
          countdown_seconds, timer_status, timer_ends_at, thermometer_visual_mode,
          embed_media_url, trust_badge_text, pinned_donation_id,
          settings_seq, updated_at
        ) VALUES (
          1, 'Annual Gala & Benefit Auction', 'Supporting Community Programs & Education',
          50000000, 0, 0, 1.0, 0, 'Board of Directors Matching Grant', 0,
          NULL, 'https://give.hope.org/donate', 'dots', 'star', '', '#FFFFFF',
          '1234', '9999',
          '[{"cents":10000000,"label":"Foundation"},{"cents":25000000,"label":"Staffing"},{"cents":50000000,"label":"Legal Clinic"},{"cents":100000000,"label":"Expansion"}]',
          0, 0, 'champagne', 85, 0.12, '', 12, 950000, 8000, 1,
          300, 'stopped', NULL, 'classic', '', '501(c)(3) Tax-Deductible Contribution', NULL,
          1, ?
        )
      `).run(Date.now());
    }
    // 3. Held / Staged Items
    db.exec(`
      CREATE TABLE IF NOT EXISTS held_donations (
        donation_id TEXT PRIMARY KEY,
        held_at INTEGER NOT NULL,
        held_by TEXT,
        reason TEXT
      );
    `);

    // Migrate from legacy yanked_chyrons table if it exists
    try {
      const tableCheck = db.query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='yanked_chyrons'`
      ).get();
      if (tableCheck) {
        db.exec(`INSERT OR IGNORE INTO held_donations SELECT donation_id, yanked_at, yanked_by, reason FROM yanked_chyrons;`);
        db.exec(`DROP TABLE yanked_chyrons;`);
      }
    } catch {
      // Ignore if already migrated
    }

    // 4. Fast Active Card Lookup Table (O(1) duplicate prevention)
    db.exec(`
      CREATE TABLE IF NOT EXISTS active_card (
        card_number TEXT PRIMARY KEY,
        donation_id TEXT NOT NULL,
        entered_by TEXT,
        amount_cents INTEGER NOT NULL DEFAULT 0,
        donor_name TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
    `);

    // 5. Milestones Table (Zero-JSON Schema)
    db.exec(`
      CREATE TABLE IF NOT EXISTS milestone (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sort_order INTEGER NOT NULL,
        percent_of_goal REAL,
        cents INTEGER,
        label TEXT NOT NULL,
        celebrate INTEGER NOT NULL DEFAULT 1
      );
    `);

    // Seed default milestones if empty
    const milestoneCount = db.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM milestone`).get();
    if (!milestoneCount || milestoneCount.count === 0) {
      const insertMilestone = db.prepare(`
        INSERT INTO milestone (sort_order, percent_of_goal, cents, label, celebrate)
        VALUES (?, ?, ?, ?, ?)
      `);
      insertMilestone.run(1, 25, null, "Foundation", 1);
      insertMilestone.run(2, 50, null, "Staffing", 1);
      insertMilestone.run(3, 75, null, "Legal Clinic", 1);
      insertMilestone.run(4, 100, null, "Expansion Goal", 1);
    }

    // 6. Quick Ask Tiers Table (Zero-JSON Schema)
    db.exec(`
      CREATE TABLE IF NOT EXISTS ask_tier (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sort_order INTEGER NOT NULL,
        cents INTEGER NOT NULL,
        label TEXT NOT NULL
      );
    `);

    // Seed default ask tiers if empty
    const tierCount = db.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM ask_tier`).get();
    if (!tierCount || tierCount.count === 0) {
      const insertTier = db.prepare(`
        INSERT INTO ask_tier (sort_order, cents, label)
        VALUES (?, ?, ?)
      `);
      insertTier.run(1, 1000000, "$10,000");
      insertTier.run(2, 500000, "$5,000");
      insertTier.run(3, 250000, "$2,500");
      insertTier.run(4, 100000, "$1,000");
      insertTier.run(5, 50000, "$500");
    }

    // 7. Connector Leases & Checkpoints
    db.exec(`
      CREATE TABLE IF NOT EXISTS connector_state (
        connector_id TEXT PRIMARY KEY,
        last_cursor TEXT,
        lease_expires_at INTEGER NOT NULL DEFAULT 0,
        last_poll_at INTEGER,
        last_error TEXT
      );
    `);

    // Additive migration columns for existing tables
    const userVersionRow = db.query<{ user_version: number }, []>(`PRAGMA user_version;`).get();
    const userVersion = userVersionRow ? userVersionRow.user_version : 0;

    if (userVersion < 2) {
      // Ensure columns exist on ledger
      try { db.exec(`ALTER TABLE ledger ADD COLUMN donor_phonetic TEXT;`); } catch {}
      try { db.exec(`ALTER TABLE ledger ADD COLUMN table_number TEXT;`); } catch {}

      // Ensure columns exist on event_state
      try { db.exec(`ALTER TABLE event_state ADD COLUMN event_subtitle TEXT NOT NULL DEFAULT 'Supporting Community Programs & Education';`); } catch {}
      try { db.exec(`ALTER TABLE event_state ADD COLUMN theme_preset TEXT NOT NULL DEFAULT 'champagne';`); } catch {}
      try { db.exec(`ALTER TABLE event_state ADD COLUMN brand_hue REAL NOT NULL DEFAULT 85;`); } catch {}
      try { db.exec(`ALTER TABLE event_state ADD COLUMN brand_chroma REAL NOT NULL DEFAULT 0.12;`); } catch {}
      try { db.exec(`ALTER TABLE event_state ADD COLUMN brand_accent_hex TEXT NOT NULL DEFAULT '';`); } catch {}
      try { db.exec(`ALTER TABLE event_state ADD COLUMN brand_radius_px INTEGER NOT NULL DEFAULT 12;`); } catch {}
      try { db.exec(`ALTER TABLE event_state ADD COLUMN major_gift_threshold_cents INTEGER NOT NULL DEFAULT 950000;`); } catch {}
      try { db.exec(`ALTER TABLE event_state ADD COLUMN stage_delay_ms INTEGER NOT NULL DEFAULT 0;`); } catch {}
      try { db.exec(`ALTER TABLE event_state ADD COLUMN confetti_on_milestone INTEGER NOT NULL DEFAULT 1;`); } catch {}
      try { db.exec(`ALTER TABLE event_state ADD COLUMN settings_seq INTEGER NOT NULL DEFAULT 1;`); } catch {}

      db.exec(`PRAGMA user_version = 2;`);
    }

    if (userVersion < 3) {
      try { db.exec(`ALTER TABLE event_state ADD COLUMN qr_style TEXT NOT NULL DEFAULT 'dots';`); } catch {}
      try { db.exec(`ALTER TABLE event_state ADD COLUMN qr_center_icon TEXT NOT NULL DEFAULT 'star';`); } catch {}
      try { db.exec(`ALTER TABLE event_state ADD COLUMN qr_fg_color TEXT NOT NULL DEFAULT '';`); } catch {}
      try { db.exec(`ALTER TABLE event_state ADD COLUMN qr_bg_color TEXT NOT NULL DEFAULT '#FFFFFF';`); } catch {}

      db.exec(`PRAGMA user_version = 3;`);
    }

    if (userVersion < 4) {
      try { db.exec(`ALTER TABLE event_state ADD COLUMN countdown_seconds INTEGER NOT NULL DEFAULT 300;`); } catch {}
      try { db.exec(`ALTER TABLE event_state ADD COLUMN timer_status TEXT NOT NULL DEFAULT 'stopped';`); } catch {}
      try { db.exec(`ALTER TABLE event_state ADD COLUMN timer_ends_at INTEGER DEFAULT NULL;`); } catch {}
      try { db.exec(`ALTER TABLE event_state ADD COLUMN thermometer_visual_mode TEXT NOT NULL DEFAULT 'classic';`); } catch {}
      try { db.exec(`ALTER TABLE event_state ADD COLUMN embed_media_url TEXT DEFAULT '';`); } catch {}
      try { db.exec(`ALTER TABLE event_state ADD COLUMN trust_badge_text TEXT NOT NULL DEFAULT '501(c)(3) Tax-Deductible Contribution';`); } catch {}
      try { db.exec(`ALTER TABLE event_state ADD COLUMN pinned_donation_id TEXT DEFAULT NULL;`); } catch {}
      try { db.exec(`ALTER TABLE ledger ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;`); } catch {}

      db.exec(`PRAGMA user_version = 4;`);
    }
  })();
}
