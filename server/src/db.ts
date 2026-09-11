import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

/**
 * Schema version. Fresh databases are created at this version directly.
 * The only supported upgrade path is from the previous released version (13);
 * anything older must start from a fresh database or a restored backup.
 */
export const SCHEMA_VERSION = 14;

export function initDatabase(dbPath: string = process.env.GIVEBAR_DB_PATH || "data/givebar.sqlite"): Database {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  migrateSchema(db);
  return db;
}

function tableExists(db: Database, name: string): boolean {
  return Boolean(db.query<{ name: string }, [string]>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
}

function columnExists(db: Database, table: string, column: string): boolean {
  return db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
}

/** Live event_state columns. Drives the fresh CREATE TABLE and the add-if-missing pass on upgrade. */
const EVENT_STATE_COLUMNS: [string, string][] = [
  ["event_name", "TEXT NOT NULL DEFAULT 'Annual Gala & Benefit Auction'"],
  ["event_subtitle", "TEXT NOT NULL DEFAULT 'Supporting Community Programs & Education'"],
  ["event_title", "TEXT NOT NULL DEFAULT ''"],
  ["goal_cents", "INTEGER NOT NULL DEFAULT 50000000"],
  ["match_total_cents", "INTEGER NOT NULL DEFAULT 0"],
  ["match_ratio", "REAL NOT NULL DEFAULT 1.0"],
  ["is_match_active", "INTEGER NOT NULL DEFAULT 0"],
  ["match_sponsor_title", "TEXT NOT NULL DEFAULT 'Board of Directors Matching Grant'"],
  ["is_frozen", "INTEGER NOT NULL DEFAULT 0"],
  ["qr_url", "TEXT NOT NULL DEFAULT ''"],
  ["display_url", "TEXT NOT NULL DEFAULT ''"],
  ["qr_style", "TEXT NOT NULL DEFAULT 'dots'"],
  ["qr_center_icon", "TEXT NOT NULL DEFAULT 'star'"],
  ["qr_fg_color", "TEXT NOT NULL DEFAULT ''"],
  ["qr_bg_color", "TEXT NOT NULL DEFAULT '#FFFFFF'"],
  ["qr_image_url", "TEXT NOT NULL DEFAULT ''"],
  ["qr_image_backdrop", "INTEGER NOT NULL DEFAULT 1"],
  ["odometer_floor_cents", "INTEGER NOT NULL DEFAULT 0"],
  ["stage_reset_seq", "INTEGER NOT NULL DEFAULT 0"],
  ["theme_preset", "TEXT NOT NULL DEFAULT 'champagne'"],
  ["brand_hue", "REAL NOT NULL DEFAULT 85"],
  ["brand_chroma", "REAL NOT NULL DEFAULT 0.12"],
  ["brand_accent_hex", "TEXT NOT NULL DEFAULT ''"],
  ["brand_radius_px", "INTEGER NOT NULL DEFAULT 12"],
  ["major_gift_threshold_cents", "INTEGER NOT NULL DEFAULT 950000"],
  ["stage_delay_ms", "INTEGER NOT NULL DEFAULT 8000"],
  ["trust_badge_text", "TEXT NOT NULL DEFAULT '501(c)(3) Tax-Deductible Contribution'"],
  ["logo_url", "TEXT NOT NULL DEFAULT ''"],
  ["background_style", "TEXT NOT NULL DEFAULT 'plain'"],
  ["background_image_url", "TEXT NOT NULL DEFAULT ''"],
  ["background_video_url", "TEXT NOT NULL DEFAULT ''"],
  ["gradient_start", "TEXT NOT NULL DEFAULT '#183b46'"],
  ["gradient_end", "TEXT NOT NULL DEFAULT '#39213d'"],
  ["gradient_angle", "INTEGER NOT NULL DEFAULT 135"],
  ["gradient_intensity", "INTEGER NOT NULL DEFAULT 35"],
  ["bar_color", "TEXT NOT NULL DEFAULT ''"],
  ["text_color", "TEXT NOT NULL DEFAULT ''"],
  ["font_family", "TEXT NOT NULL DEFAULT 'system'"],
  ["chart_orientation", "TEXT NOT NULL DEFAULT 'horizontal'"],
  ["marker_mode", "TEXT NOT NULL DEFAULT 'milestones'"],
  ["marker_step_cents", "INTEGER NOT NULL DEFAULT 10000000"],
  ["show_qr", "INTEGER NOT NULL DEFAULT 1"],
  ["show_recent_donations", "INTEGER NOT NULL DEFAULT 1"],
  ["show_live_indicator", "INTEGER NOT NULL DEFAULT 1"],
  ["show_goal", "INTEGER NOT NULL DEFAULT 1"],
  ["stage_message", "TEXT NOT NULL DEFAULT ''"],
  ["stage_message_visible", "INTEGER NOT NULL DEFAULT 0"],
  ["impact_messages", "TEXT NOT NULL DEFAULT '[]'"],
  ["feature_card_number", "INTEGER NOT NULL DEFAULT 0"],
  ["feature_table_number", "INTEGER NOT NULL DEFAULT 0"],
  ["settings_seq", "INTEGER NOT NULL DEFAULT 1"],
  ["updated_at", "INTEGER NOT NULL DEFAULT 0"]
];

/** Final schema. Every statement is idempotent so it can run on any supported database. */
function createSchema(db: Database): void {
  // Append-only event ledger: the single financial source of truth.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,         -- 'create', 'amend', 'void', 'restore', 'match_apply', 'match_release'
      donation_id TEXT NOT NULL,        -- UUID minted on the client form, or a stable import identifier
      supersedes_seq INTEGER,           -- Superseded record for amendments, voids, and restores
      amount_cents INTEGER NOT NULL,
      donor_name TEXT NOT NULL,
      display_name TEXT,                -- Public chyron text ("Anonymous Supporter" when anonymous)
      is_anonymous INTEGER DEFAULT 0,
      payment_method TEXT NOT NULL,     -- 'pledge', 'card', 'check', 'cash', 'match'
      source TEXT NOT NULL,             -- 'manual', 'bloomerang', 'rehearsal'
      source_txn_id TEXT,               -- Upstream transaction identifier (unique with source)
      card_number TEXT,                 -- Physical pledge card serial (#0412)
      entered_by TEXT,                  -- Operator display name or importer name
      notes TEXT,                       -- Team-only note; never reaches the audience feed
      donor_phonetic TEXT,
      table_number TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_donation_id ON ledger(donation_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_source_txn ON ledger(source, source_txn_id) WHERE source_txn_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_ledger_card_number ON ledger(card_number) WHERE card_number IS NOT NULL;
  `);

  db.exec(`CREATE TABLE IF NOT EXISTS event_state (id INTEGER PRIMARY KEY CHECK (id = 1), ${EVENT_STATE_COLUMNS.map(([name, ddl]) => `${name} ${ddl}`).join(", ")});`);
  db.query(`INSERT OR IGNORE INTO event_state (id, updated_at) VALUES (1, ?)`).run(Date.now());

  db.exec(`
    CREATE TABLE IF NOT EXISTS held_donations (
      donation_id TEXT PRIMARY KEY,
      held_at INTEGER NOT NULL,
      held_by TEXT,
      reason TEXT
    );
    CREATE TABLE IF NOT EXISTS active_card (
      card_number TEXT PRIMARY KEY,
      donation_id TEXT NOT NULL,
      entered_by TEXT,
      amount_cents INTEGER NOT NULL DEFAULT 0,
      donor_name TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS milestone (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sort_order INTEGER NOT NULL,
      percent_of_goal REAL,
      cents INTEGER,
      label TEXT NOT NULL,
      celebrate INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS ask_tier (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sort_order INTEGER NOT NULL,
      cents INTEGER NOT NULL,
      label TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fundraising_sync (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      form_id TEXT NOT NULL DEFAULT '',
      start_date TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 0,
      last_sync_at INTEGER,
      last_error TEXT NOT NULL DEFAULT '',
      imported_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS fundraising_receipt (
      transaction_id TEXT PRIMARY KEY,
      donation_id TEXT NOT NULL,
      remote_snapshot TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS operator_account (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      pin_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'operator')),
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS operator_session (
      token_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES operator_account(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS operator_session_account ON operator_session(account_id);
    CREATE TABLE IF NOT EXISTS operator_invite (
      token_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES operator_account(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS operator_invite_account ON operator_invite(account_id);
    CREATE TABLE IF NOT EXISTS login_attempt (
      key TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS access_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id TEXT,
      action TEXT NOT NULL,
      target_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_note (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  db.query(`INSERT OR IGNORE INTO fundraising_sync (id) VALUES (1)`).run();

  if (!db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM milestone`).get()!.n) {
    const insert = db.prepare(`INSERT INTO milestone (sort_order, percent_of_goal, cents, label, celebrate) VALUES (?, ?, NULL, ?, 1)`);
    insert.run(1, 25, "Foundation");
    insert.run(2, 50, "Staffing");
    insert.run(3, 75, "Legal Clinic");
    insert.run(4, 100, "Expansion Goal");
  }
  if (!db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ask_tier`).get()!.n) {
    const insert = db.prepare(`INSERT INTO ask_tier (sort_order, cents, label) VALUES (?, ?, ?)`);
    [[5000000, "$50,000"], [2500000, "$25,000"], [1000000, "$10,000"], [500000, "$5,000"], [200000, "$2,000"], [100000, "$1,000"], [50000, "$500"]]
      .forEach(([cents, label], index) => insert.run(index + 1, cents, label));
  }
}

/** Upgrade from schema 13 (the previous release): retired columns and tables go away, live columns are guaranteed. */
function upgradeFrom13(db: Database): void {
  for (const [name, ddl] of EVENT_STATE_COLUMNS) {
    if (!columnExists(db, "event_state", name)) db.exec(`ALTER TABLE event_state ADD COLUMN ${name} ${ddl};`);
  }
  const retiredEventColumns = [
    "match_pool_cents", "manual_override_cents", "qr_donate_url", "entry_pin", "control_pin", "milestones_json",
    "confetti_trigger", "confetti_on_milestone", "countdown_seconds", "timer_status", "timer_ends_at",
    "thermometer_visual_mode", "embed_media_url", "pinned_donation_id", "feature_timer",
    "bloomerang_api_key", "bloomerang_last_sync_at", "bloomerang_last_error"
  ];
  for (const column of retiredEventColumns) {
    if (columnExists(db, "event_state", column)) db.exec(`ALTER TABLE event_state DROP COLUMN ${column};`);
  }
  if (columnExists(db, "ledger", "is_pinned")) db.exec(`ALTER TABLE ledger DROP COLUMN is_pinned;`);
  db.exec(`DROP TABLE IF EXISTS connector_state;`);
  db.exec(`DROP INDEX IF EXISTS idx_ledger_seq;`);
  // Presenter/display roles were never issued; the account table only knows admin and operator.
  db.exec(`DELETE FROM operator_account WHERE role NOT IN ('admin', 'operator');`);
  // Stage delay is the documented invariant; a zero here came from the old default, not a choice.
  db.exec(`UPDATE event_state SET stage_delay_ms = 8000 WHERE stage_delay_ms = 0;`);
}

export function migrateSchema(db: Database): void {
  db.transaction(() => {
    const fresh = !tableExists(db, "event_state");
    const version = db.query<{ user_version: number }, []>(`PRAGMA user_version;`).get()!.user_version;
    if (!fresh && version !== 13 && version !== SCHEMA_VERSION) {
      throw new Error(`Unsupported Givebar database schema version ${version}. Restore a backup taken with the previous release or start from a fresh database.`);
    }
    createSchema(db);
    if (!fresh && version === 13) upgradeFrom13(db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  })();
}
